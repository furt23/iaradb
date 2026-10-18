//! Aggregates over window frames: whole partitions run through the group
//! accumulators (every aggregate, DISTINCT included); moving frames slide a
//! state along each partition.

use std::collections::VecDeque;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{SortOptions, cast, filter, take};
use arrow::datatypes::*;

use crate::error::{Result, WhError};
use crate::exec::accumulators::create_accumulator;
use crate::exec::window::layout::{Layout, NO_ROW};
use crate::exec::window::sliding::{Count, Extreme, FloatSum, IntSum, Moments, slide};
use crate::exec::window::{WindowFunctionExpr, valid_rows};
use crate::expr::{AggFunc, WindowFunc};
use crate::window::{FrameBound, FrameUnits};
use arrow::buffer::NullBuffer;
use crate::physical::expr::null_as_false;

pub fn evaluate(f: &WindowFunctionExpr, batch: &RecordBatch, layout: &Layout) -> Result<ArrayRef> {
    let WindowFunc::Agg(func) = f.func else {
        return Err(WhError::Execution(format!("{} is not an aggregate", f.func.name())));
    };
    if f.frame.is_whole() {
        return whole_partition(f, func, batch, layout);
    }
    if f.distinct || func == AggFunc::Median {
        return Err(WhError::NotSupported(format!(
            "{}{} over a moving window frame (it is supported over whole partitions)",
            func.name(),
            if f.distinct { "(DISTINCT ..)" } else { "" }
        )));
    }
    let arg = f.args.first().map(|a| a.evaluate_array(batch)).transpose()?;
    let fl = f.filter.as_ref().map(|x| x.evaluate_array(batch)).transpose()?;
    let needs_mask = fl.is_some() || arg.as_ref().is_some_and(|a| a.logical_null_count() > 0);
    let valid = if needs_mask { Some(valid_rows(arg.as_ref(), fl.as_ref(), layout)?) } else { None };
    let valid = valid.as_deref();
    let frame = &f.frame;
    let sorted: ArrayRef = match (func, arg) {
        (AggFunc::Count, _) => {
            let v = slide(layout, frame, 0i64, || Count { valid, n: 0 }, |s| s.n)?;
            Arc::new(Int64Array::from(v))
        }
        (_, None) => return Err(WhError::Plan(format!("{}() requires an argument", func.name()))),
        (AggFunc::Sum | AggFunc::Mean, Some(a)) => sum_or_mean(func, &layout.sorted(&a)?, valid, layout, f)?,
        (AggFunc::Std | AggFunc::StdPop | AggFunc::Var | AggFunc::VarPop, Some(a)) => {
            let x = cast(&layout.sorted(&a)?, &DataType::Float64)?;
            let values = x.as_primitive::<Float64Type>().values();
            let ddof = if matches!(func, AggFunc::Std | AggFunc::Var) { 1.0 } else { 0.0 };
            let sqrt = matches!(func, AggFunc::Std | AggFunc::StdPop);
            let v = slide(
                layout,
                frame,
                None,
                || Moments { values, valid, n: 0.0, mean: 0.0, m2: 0.0 },
                |s| s.variance(ddof).map(|v| if sqrt { v.sqrt() } else { v }),
            )?;
            Arc::new(Float64Array::from(v))
        }
        (AggFunc::Min | AggFunc::Max, Some(a)) => {
            let a = layout.sorted(&a)?;
            let cmp = make_comparator(a.as_ref(), a.as_ref(), SortOptions::default())?;
            let min = func == AggFunc::Min;
            let pos = slide(layout, frame, NO_ROW, || Extreme { cmp: &cmp, valid, min, deque: VecDeque::new() }, |s| s.position())?;
            let idx: UInt32Array = pos.into_iter().map(|p| (p != NO_ROW).then_some(p)).collect();
            take(&a, &idx, None)?
        }
        (other, _) => return Err(WhError::Execution(format!("{} over a window frame", other.name()))),
    };
    layout.unsort(sorted)
}

/// `sum` / `avg` over a moving frame (`a` in sorted order).
fn sum_or_mean(func: AggFunc, a: &ArrayRef, valid: Option<&[bool]>, layout: &Layout, f: &WindowFunctionExpr) -> Result<ArrayRef> {
    let frame = &f.frame;
    let running = frame.units == FrameUnits::Rows
        && matches!(frame.start, FrameBound::UnboundedPreceding)
        && matches!(frame.end, FrameBound::CurrentRow);
    if func == AggFunc::Sum && running {
        if let Some(out) = running_sum(a, valid, layout, &f.out_type)? {
            return Ok(out);
        }
    }
    let mean = func == AggFunc::Mean;
    macro_rules! exact {
        ($values:expr, $scale:expr) => {{
            let values = $values;
            let v = slide(layout, frame, None, || IntSum { values, valid, sum: 0, n: 0 }, |s| (s.n > 0).then_some((s.sum, s.n)))?;
            if mean {
                let div = 10f64.powi($scale as i32);
                let m: Float64Array = v.into_iter().map(|x| x.map(|(s, n)| s as f64 / n as f64 / div)).collect();
                return Ok(Arc::new(m));
            }
            v.into_iter().map(|x| x.map(|(s, _)| s)).collect::<Vec<Option<i128>>>()
        }};
    }
    let sums: Vec<Option<i128>> = match a.data_type() {
        DataType::Float16 | DataType::Float32 | DataType::Float64 => {
            let x = cast(a, &DataType::Float64)?;
            let values = x.as_primitive::<Float64Type>().values();
            let v = slide(
                layout,
                frame,
                None,
                || FloatSum { values, valid, sum: 0.0, comp: 0.0, n: 0, special: [0; 3] },
                |s| s.value().map(|v| if mean { v / s.n as f64 } else { v }),
            )?;
            return Ok(Arc::new(Float64Array::from(v)));
        }
        DataType::Decimal128(_, s) => exact!(a.as_primitive::<Decimal128Type>().values().as_ref(), *s),
        t if t.is_unsigned_integer() => {
            let x = cast(a, &DataType::UInt64)?;
            exact!(x.as_primitive::<UInt64Type>().values().as_ref(), 0)
        }
        t if t.is_integer() || matches!(t, DataType::Null | DataType::Boolean) => {
            let x = cast(a, &DataType::Int64)?;
            exact!(x.as_primitive::<Int64Type>().values().as_ref(), 0)
        }
        t => return Err(WhError::NotSupported(format!("{} over {t}", func.name()))),
    };
    let overflow = || WhError::Execution(format!("integer overflow in {}() over a window", func.name()));
    Ok(match &f.out_type {
        DataType::Decimal128(p, s) => Arc::new(Decimal128Array::from(sums).with_precision_and_scale(*p, *s)?),
        DataType::UInt64 => {
            let v = sums.into_iter().map(|x| x.map(|s| u64::try_from(s).map_err(|_| overflow())).transpose()).collect::<Result<Vec<_>>>()?;
            Arc::new(UInt64Array::from(v))
        }
        _ => {
            let v = sums.into_iter().map(|x| x.map(|s| i64::try_from(s).map_err(|_| overflow())).transpose()).collect::<Result<Vec<_>>>()?;
            Arc::new(Int64Array::from(v))
        }
    })
}

/// `sum` from the start of the partition to the current row (`cum_sum`) of
/// integers or decimals, as prefix sums (`a` in sorted order); NULL until
/// the first value. None: another type, left to the sliding frame.
fn running_sum(a: &ArrayRef, valid: Option<&[bool]>, layout: &Layout, out: &DataType) -> Result<Option<ArrayRef>> {
    let overflow = || WhError::Execution("integer overflow in sum() over a window".into());
    fn prefix<T: Copy + Default>(
        values: &[T],
        valid: Option<&[bool]>,
        layout: &Layout,
        add: impl Fn(T, T) -> Option<T>,
        overflow: impl Fn() -> WhError,
    ) -> Result<(Vec<T>, Option<NullBuffer>)> {
        let n = layout.n;
        let mut sums = vec![T::default(); n];
        let mut seen = valid.map(|_| vec![false; n]);
        for p in &layout.partitions {
            let (mut acc, mut any) = (T::default(), false);
            for i in p.clone() {
                if valid.is_none_or(|v| v[i]) {
                    acc = add(acc, values[i]).ok_or_else(&overflow)?;
                    any = true;
                }
                sums[i] = acc;
                if let Some(s) = seen.as_mut() {
                    s[i] = any;
                }
            }
        }
        Ok((sums, seen.map(NullBuffer::from)))
    }
    Ok(Some(match (a.data_type(), out) {
        (t, DataType::Int64) if t.is_signed_integer() || matches!(t, DataType::Boolean) => {
            let x = cast(a, &DataType::Int64)?;
            let (sums, nulls) = prefix(x.as_primitive::<Int64Type>().values(), valid, layout, i64::checked_add, overflow)?;
            Arc::new(Int64Array::new(sums.into(), nulls))
        }
        (DataType::Decimal128(..), DataType::Decimal128(p, s)) => {
            let (sums, nulls) = prefix(a.as_primitive::<Decimal128Type>().values(), valid, layout, i128::checked_add, overflow)?;
            Arc::new(Decimal128Array::new(sums.into(), nulls).with_precision_and_scale(*p, *s)?)
        }
        _ => return Ok(None),
    }))
}

/// Aggregate each partition once with the group accumulators and broadcast
/// the result to its rows.
fn whole_partition(f: &WindowFunctionExpr, func: AggFunc, batch: &RecordBatch, layout: &Layout) -> Result<ArrayRef> {
    let mut gids = vec![0u32; layout.n];
    for (g, p) in layout.partitions.iter().enumerate() {
        for i in p.clone() {
            gids[layout.row(i)] = g as u32;
        }
    }
    let groups = layout.partitions.len().max(1);
    whole_partition_gids(f, func, batch, &gids, groups)
}

pub fn whole_partition_gids(
    f: &WindowFunctionExpr,
    func: AggFunc,
    batch: &RecordBatch,
    gids: &[u32],
    groups: usize,
) -> Result<ArrayRef> {
    let args = f.args.iter().map(|a| a.evaluate_array(batch)).collect::<Result<Vec<_>>>()?;
    let input_type = args.first().map(|a| a.data_type().clone());
    if let Some(row_acc) = crate::exec::accumulators::create_row_accumulator(func, input_type.as_ref(), f.distinct) {
        let mut accs = crate::exec::acc_rows::AccSet::new(vec![crate::exec::acc_rows::AccPart::Row(row_acc)]);
        let fl = f.filter.as_ref().map(|fl| fl.evaluate_array(batch)).transpose()?;
        accs.update(&[(args, fl)], gids, groups)?;
        let per_partition = accs.finish(groups)?.into_iter().next().expect("one column");
        return Ok(take(&per_partition, &UInt32Array::from(gids.to_vec()), None)?);
    }
    let mut acc = create_accumulator(func, input_type.as_ref(), f.distinct)?;
    match &f.filter {
        Some(fl) => {
            let mask = null_as_false(fl.evaluate_array(batch)?.as_boolean());
            let vals = args.iter().map(|a| filter(a, &mask)).collect::<Result<Vec<_>, _>>()?;
            let kept: Vec<u32> = gids.iter().zip(mask.values().iter()).filter_map(|(g, m)| m.then_some(*g)).collect();
            acc.update(&vals, &kept, groups)?;
        }
        None => acc.update(&args, gids, groups)?,
    }
    let per_partition = acc.finish(groups)?;
    Ok(take(&per_partition, &UInt32Array::from(gids.to_vec()), None)?)
}
