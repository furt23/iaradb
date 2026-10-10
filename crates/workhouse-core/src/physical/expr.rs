//! Physical (executable) expressions: column references resolved to indices,
//! types coerced, constants folded. Evaluation is fully vectorized on Arrow
//! arrays and dispatches to SIMD-friendly Arrow kernels.

use std::fmt;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::kernels::{cmp, numeric, zip::zip};
use arrow::compute::{CastOptions, and_kleene, cast_with_options, is_not_null, is_null, not, or_kleene};
use arrow::datatypes::*;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use hashbrown::HashSet;

use crate::error::{Result, WhError};
use crate::expr::{Expr, Operator, ScalarFunc};
use crate::physical::functions;
use crate::scalar::Scalar;
use crate::schema::PlanSchema;
use crate::types::*;
use crate::types::adapt_literal;

/// Result of evaluating an expression: a full column or a single scalar.
#[derive(Clone, Debug)]
pub enum ColumnarValue {
    Array(ArrayRef),
    Scalar(Scalar),
}

impl ColumnarValue {
    pub fn into_array(self, n: usize) -> Result<ArrayRef> {
        match self {
            ColumnarValue::Array(a) => Ok(a),
            ColumnarValue::Scalar(s) => s.to_array(n),
        }
    }
    pub fn data_type(&self) -> &DataType {
        match self {
            ColumnarValue::Array(a) => a.data_type(),
            ColumnarValue::Scalar(s) => s.data_type(),
        }
    }
    pub fn is_scalar(&self) -> bool {
        matches!(self, ColumnarValue::Scalar(_))
    }
}

impl Datum for ColumnarValue {
    fn get(&self) -> (&dyn Array, bool) {
        match self {
            ColumnarValue::Array(a) => (a.as_ref(), false),
            ColumnarValue::Scalar(s) => (s.array().as_ref(), true),
        }
    }
}

fn wrap(result: ArrayRef, scalar: bool) -> ColumnarValue {
    if scalar && result.len() == 1 {
        ColumnarValue::Scalar(Scalar::new(result))
    } else {
        ColumnarValue::Array(result)
    }
}

#[derive(Debug)]
pub enum InSet {
    Int(HashSet<i64>),
    Str(HashSet<Box<str>>),
}

#[derive(Debug, Clone)]
pub enum PhysExpr {
    Column { index: usize, name: String, dt: DataType },
    Literal(Scalar),
    Binary { left: Box<PhysExpr>, op: Operator, right: Box<PhysExpr>, dt: DataType },
    Not(Box<PhysExpr>),
    Negative(Box<PhysExpr>),
    IsNull(Box<PhysExpr>),
    IsNotNull(Box<PhysExpr>),
    Cast { expr: Box<PhysExpr>, to: DataType, safe: bool },
    Case { when_then: Vec<(PhysExpr, PhysExpr)>, otherwise: Option<Box<PhysExpr>>, dt: DataType },
    InList { expr: Box<PhysExpr>, set: Arc<InSet>, has_null: bool, negated: bool },
    Like {
        expr: Box<PhysExpr>,
        pattern: Scalar,
        negated: bool,
        case_insensitive: bool,
        matcher: Option<Arc<crate::physical::like::LikeMatcher>>,
    },
    Function { func: ScalarFunc, args: Vec<PhysExpr>, dt: DataType },
}

#[derive(Debug, Clone)]
pub struct PhysSortExpr {
    pub expr: PhysExpr,
    pub descending: bool,
    pub nulls_first: bool,
}

impl PhysExpr {
    pub fn data_type(&self) -> DataType {
        match self {
            PhysExpr::Column { dt, .. } => dt.clone(),
            PhysExpr::Literal(s) => s.data_type().clone(),
            PhysExpr::Binary { dt, .. } => dt.clone(),
            PhysExpr::Not(_) | PhysExpr::IsNull(_) | PhysExpr::IsNotNull(_) => DataType::Boolean,
            PhysExpr::InList { .. } | PhysExpr::Like { .. } => DataType::Boolean,
            PhysExpr::Negative(e) => e.data_type(),
            PhysExpr::Cast { to, .. } => to.clone(),
            PhysExpr::Case { dt, .. } => dt.clone(),
            PhysExpr::Function { dt, .. } => dt.clone(),
        }
    }

    fn has_columns(&self) -> bool {
        match self {
            PhysExpr::Column { .. } => true,
            PhysExpr::Literal(_) => false,
            PhysExpr::Binary { left, right, .. } => left.has_columns() || right.has_columns(),
            PhysExpr::Not(e) | PhysExpr::Negative(e) | PhysExpr::IsNull(e) | PhysExpr::IsNotNull(e) => {
                e.has_columns()
            }
            PhysExpr::Cast { expr, .. } => expr.has_columns(),
            PhysExpr::Case { when_then, otherwise, .. } => {
                when_then.iter().any(|(w, t)| w.has_columns() || t.has_columns())
                    || otherwise.as_ref().is_some_and(|o| o.has_columns())
            }
            PhysExpr::InList { expr, .. } | PhysExpr::Like { expr, .. } => expr.has_columns(),
            // random() must not be folded into a constant
            PhysExpr::Function { func, args, .. } => *func == ScalarFunc::Random || args.iter().any(|a| a.has_columns()),
        }
    }

    /// Column index if this is a bare column reference.
    pub fn as_column_index(&self) -> Option<usize> {
        match self {
            PhysExpr::Column { index, .. } => Some(*index),
            _ => None,
        }
    }

    pub fn evaluate_array(&self, batch: &RecordBatch) -> Result<ArrayRef> {
        self.evaluate(batch)?.into_array(batch.num_rows())
    }

    pub fn evaluate(&self, batch: &RecordBatch) -> Result<ColumnarValue> {
        let n = batch.num_rows();
        Ok(match self {
            PhysExpr::Column { index, .. } => ColumnarValue::Array(batch.column(*index).clone()),
            PhysExpr::Literal(s) => ColumnarValue::Scalar(s.clone()),
            PhysExpr::Binary { left, op, right, .. } => eval_binary(left, *op, right, batch)?,
            PhysExpr::Not(e) => {
                let v = e.evaluate(batch)?;
                let s = v.is_scalar();
                let a = v.into_array(if s { 1 } else { n })?;
                wrap(Arc::new(not(a.as_boolean())?), s)
            }
            PhysExpr::Negative(e) => {
                let v = e.evaluate(batch)?;
                let s = v.is_scalar();
                let a = v.into_array(if s { 1 } else { n })?;
                wrap(numeric::neg_wrapping(&a)?, s)
            }
            PhysExpr::IsNull(e) | PhysExpr::IsNotNull(e) => {
                let v = e.evaluate(batch)?;
                let s = v.is_scalar();
                let a = v.into_array(if s { 1 } else { n })?;
                let r = if matches!(self, PhysExpr::IsNull(_)) { is_null(&a)? } else { is_not_null(&a)? };
                wrap(Arc::new(r), s)
            }
            PhysExpr::Cast { expr, to, safe } => {
                let v = expr.evaluate(batch)?;
                let s = v.is_scalar();
                let a = v.into_array(if s { 1 } else { n })?;
                let opts = CastOptions { safe: *safe, ..Default::default() };
                wrap(cast_with_options(&a, to, &opts)?, s)
            }
            PhysExpr::Case { when_then, otherwise, dt } => {
                let mut acc = match otherwise {
                    Some(o) => o.evaluate(batch)?,
                    None => ColumnarValue::Scalar(Scalar::null_of(dt)),
                };
                for (w, t) in when_then.iter().rev() {
                    let mask = w.evaluate(batch)?.into_array(n)?;
                    let mask = crate::physical::expr::null_as_false(mask.as_boolean());
                    let tv = t.evaluate(batch)?;
                    acc = ColumnarValue::Array(zip(&mask, &tv, &acc)?);
                }
                if n != 1 && acc.is_scalar() {
                    ColumnarValue::Array(acc.into_array(n)?)
                } else {
                    acc
                }
            }
            PhysExpr::InList { expr, set, has_null, negated } => {
                let v = expr.evaluate(batch)?;
                let s = v.is_scalar();
                let a = v.into_array(if s { 1 } else { n })?;
                wrap(Arc::new(eval_in_set(&a, set, *has_null, *negated)?), s)
            }
            PhysExpr::Like { expr, pattern, negated, case_insensitive, matcher } => {
                let v = expr.evaluate(batch)?;
                if let (Some(m), ColumnarValue::Array(a)) = (matcher, &v) {
                    if let Some(r) = m.evaluate(a.as_ref(), *negated) {
                        return Ok(ColumnarValue::Array(Arc::new(r)));
                    }
                }
                use arrow::compute::kernels::comparison as c;
                let r = match (negated, case_insensitive) {
                    (false, false) => c::like(&v, pattern)?,
                    (true, false) => c::nlike(&v, pattern)?,
                    (false, true) => c::ilike(&v, pattern)?,
                    (true, true) => c::nilike(&v, pattern)?,
                };
                wrap(Arc::new(r), v.is_scalar())
            }
            PhysExpr::Function { func, args, dt } => {
                let vals = args.iter().map(|a| a.evaluate(batch)).collect::<Result<Vec<_>>>()?;
                functions::evaluate(*func, &vals, n, dt)?
            }
        })
    }
}

fn eval_binary(left: &PhysExpr, op: Operator, right: &PhysExpr, batch: &RecordBatch) -> Result<ColumnarValue> {
    let n = batch.num_rows();
    let l = left.evaluate(batch)?;
    match op {
        Operator::And | Operator::Or => {
            let la = l.into_array(n)?;
            let lb = la.as_boolean();
            if lb.null_count() == 0 {
                let tc = lb.true_count();
                if op == Operator::And && tc == 0 {
                    return Ok(ColumnarValue::Array(la));
                }
                if op == Operator::Or && tc == lb.len() {
                    return Ok(ColumnarValue::Array(la));
                }
            }
            let ra = right.evaluate(batch)?.into_array(n)?;
            let rb = ra.as_boolean();
            let res = if op == Operator::And { and_kleene(lb, rb)? } else { or_kleene(lb, rb)? };
            Ok(ColumnarValue::Array(Arc::new(res)))
        }
        _ => {
            let r = right.evaluate(batch)?;
            let scalar = l.is_scalar() && r.is_scalar();
            if op.is_comparison() && crate::nested::is_nested(l.data_type()) {
                let m = if scalar { 1 } else { n };
                let res = crate::physical::nested_cmp::compare(op, &l.into_array(m)?, &r.into_array(m)?)?;
                return Ok(wrap(Arc::new(res), scalar));
            }
            let res: ArrayRef = match op {
                Operator::Eq => Arc::new(cmp::eq(&l, &r)?),
                Operator::NotEq => Arc::new(cmp::neq(&l, &r)?),
                Operator::Lt => Arc::new(cmp::lt(&l, &r)?),
                Operator::LtEq => Arc::new(cmp::lt_eq(&l, &r)?),
                Operator::Gt => Arc::new(cmp::gt(&l, &r)?),
                Operator::GtEq => Arc::new(cmp::gt_eq(&l, &r)?),
                Operator::Plus => numeric::add_wrapping(&l, &r)?,
                Operator::Minus => numeric::sub_wrapping(&l, &r)?,
                Operator::Multiply => numeric::mul_wrapping(&l, &r)?,
                Operator::Divide => numeric::div(&l, &r)?,
                Operator::Modulo => numeric::rem(&l, &r)?,
                Operator::StringConcat => {
                    let m = if scalar { 1 } else { n };
                    let la = l.into_array(m)?;
                    let ra = r.into_array(m)?;
                    arrow::compute::kernels::concat_elements::concat_elements_dyn(&la, &ra)?
                }
                Operator::And | Operator::Or => unreachable!(),
            };
            Ok(wrap(res, scalar))
        }
    }
}

fn eval_in_set(a: &ArrayRef, set: &InSet, has_null: bool, negated: bool) -> Result<BooleanArray> {
    let n = a.len();
    let mut values = Vec::with_capacity(n);
    let mut valid = Vec::with_capacity(n);
    let mut push = |is_valid: bool, found: bool| {
        if !is_valid {
            values.push(false);
            valid.push(false);
        } else if found {
            values.push(!negated);
            valid.push(true);
        } else if has_null {
            values.push(false);
            valid.push(false);
        } else {
            values.push(negated);
            valid.push(true);
        }
    };
    match set {
        InSet::Int(s) => {
            let c = cast_with_options(a, &DataType::Int64, &CastOptions::default())?;
            let c = c.as_primitive::<Int64Type>();
            for i in 0..n {
                let v = c.is_valid(i);
                push(v, v && s.contains(&c.value(i)));
            }
        }
        InSet::Str(s) => {
            let it: Box<dyn Iterator<Item = Option<&str>>> = match a.data_type() {
                DataType::Utf8 => Box::new(a.as_string::<i32>().iter()),
                DataType::LargeUtf8 => Box::new(a.as_string::<i64>().iter()),
                DataType::Utf8View => Box::new(a.as_string_view().iter()),
                dt => return Err(WhError::Execution(format!("IN list on {dt}"))),
            };
            for v in it {
                push(v.is_some(), v.is_some_and(|x| s.contains(x)));
            }
        }
    }
    Ok(BooleanArray::new(values.into(), Some(valid.into())))
}

/// Turn a boolean mask with nulls into one where null means false.
pub fn null_as_false(mask: &BooleanArray) -> BooleanArray {
    match mask.nulls().filter(|n| n.null_count() > 0) {
        None => BooleanArray::new(mask.values().clone(), None),
        Some(n) => BooleanArray::new(mask.values() & n.inner(), None),
    }
}

// ---------------------------------------------------------------------------
// compilation
// ---------------------------------------------------------------------------

pub fn cast_expr(e: PhysExpr, to: &DataType) -> Result<PhysExpr> {
    if &e.data_type() == to {
        return Ok(e);
    }
    if let PhysExpr::Literal(s) = &e {
        return Ok(PhysExpr::Literal(s.cast_to(to)?));
    }
    Ok(PhysExpr::Cast { expr: Box::new(e), to: to.clone(), safe: false })
}

pub(crate) fn to_utf8(e: PhysExpr) -> Result<PhysExpr> {
    cast_expr(e, &DataType::Utf8)
}

fn fold(e: PhysExpr) -> Result<PhysExpr> {
    if matches!(e, PhysExpr::Literal(_) | PhysExpr::Column { .. }) || e.has_columns() {
        return Ok(e);
    }
    let batch = RecordBatch::try_new_with_options(
        Arc::new(Schema::empty()),
        vec![],
        &RecordBatchOptions::new().with_row_count(Some(1)),
    )?;
    let v = e.evaluate(&batch)?.into_array(1)?;
    Ok(PhysExpr::Literal(Scalar::from_array(v.as_ref(), 0)?))
}

pub fn create_physical_expr(e: &Expr, schema: &PlanSchema) -> Result<PhysExpr> {
    let out = match e {
        Expr::Column(c) => {
            let index = schema.index_of(c)?;
            PhysExpr::Column { index, name: c.to_string(), dt: schema.field(index).data_type().clone() }
        }
        Expr::Literal(s) => PhysExpr::Literal(s.clone()),
        Expr::Alias(e, _) => return create_physical_expr(e, schema),
        Expr::Binary { left, op, right } => compile_binary(left, *op, right, schema)?,
        Expr::Not(e) => PhysExpr::Not(Box::new(cast_expr(create_physical_expr(e, schema)?, &DataType::Boolean)?)),
        Expr::Negative(e) => PhysExpr::Negative(Box::new(create_physical_expr(e, schema)?)),
        Expr::IsNull(e) => PhysExpr::IsNull(Box::new(create_physical_expr(e, schema)?)),
        Expr::IsNotNull(e) => PhysExpr::IsNotNull(Box::new(create_physical_expr(e, schema)?)),
        Expr::Cast { expr, to, try_cast } => {
            let c = create_physical_expr(expr, schema)?;
            if &c.data_type() == to {
                c
            } else {
                PhysExpr::Cast { expr: Box::new(c), to: to.clone(), safe: *try_cast }
            }
        }
        Expr::Case { when_then, otherwise } => {
            let dt = e.data_type(schema)?;
            let mut wt = Vec::with_capacity(when_then.len());
            for (w, t) in when_then {
                let w = cast_expr(create_physical_expr(w, schema)?, &DataType::Boolean)?;
                let t = cast_expr(create_physical_expr(t, schema)?, &dt)?;
                wt.push((w, t));
            }
            let otherwise = match otherwise {
                Some(o) => Some(Box::new(cast_expr(create_physical_expr(o, schema)?, &dt)?)),
                None => None,
            };
            PhysExpr::Case { when_then: wt, otherwise, dt }
        }
        Expr::InList { expr, list, negated } => compile_in_list(expr, list, *negated, schema)?,
        Expr::Like { expr, pattern, negated, case_insensitive } => {
            let mut c = create_physical_expr(expr, schema)?;
            if !is_string(&c.data_type()) {
                c = to_utf8(c)?;
            }
            let p = match create_physical_expr(pattern, schema)? {
                PhysExpr::Literal(s) => s.cast_to(&c.data_type())?,
                _ => return Err(WhError::NotSupported("LIKE pattern must be a constant".into())),
            };
            let matcher = p.as_str().and_then(|s| crate::physical::like::LikeMatcher::compile(s, *case_insensitive));
            PhysExpr::Like { expr: Box::new(c), pattern: p, negated: *negated, case_insensitive: *case_insensitive, matcher }
        }
        Expr::Function { func, args } => compile_function(*func, args, schema)?,
        Expr::Agg { .. } => {
            return Err(WhError::Plan(format!("aggregate '{e}' cannot be evaluated as a scalar expression")));
        }
        Expr::Window(_) => {
            return Err(WhError::Plan(format!("window function '{e}' cannot be evaluated as a scalar expression")));
        }
        Expr::Wildcard { .. } => return Err(WhError::Plan("unexpected wildcard".into())),
        Expr::ScalarSubquery(_) | Expr::InSubquery { .. } | Expr::Exists { .. } => {
            return Err(WhError::NotSupported(format!("subquery in this position is not supported: {e}")));
        }
        Expr::OuterRef(c, _) => {
            return Err(WhError::NotSupported(format!("correlated reference to {c} in this position")));
        }
    };
    fold(out)
}

fn compile_binary(left: &Expr, op: Operator, right: &Expr, schema: &PlanSchema) -> Result<PhysExpr> {
    let mut l = create_physical_expr(left, schema)?;
    let mut r = create_physical_expr(right, schema)?;
    if op.is_comparison() || op.is_arithmetic() {
        match (&l, &r) {
            (PhysExpr::Literal(_), PhysExpr::Literal(_)) => {}
            (_, PhysExpr::Literal(s)) => {
                if let Some(a) = adapt_literal(s, &l.data_type(), op) {
                    r = PhysExpr::Literal(a);
                }
            }
            (PhysExpr::Literal(s), _) => {
                if let Some(a) = adapt_literal(s, &r.data_type(), op) {
                    l = PhysExpr::Literal(a);
                }
            }
            _ => {}
        }
    }
    let (lt, rt) = (l.data_type(), r.data_type());
    if op.is_comparison() && lt == DataType::Null && rt == DataType::Null {
        return Ok(PhysExpr::Literal(Scalar::null_of(&DataType::Boolean)));
    }
    if op == Operator::StringConcat && (crate::nested::is_list(&lt) || crate::nested::is_list(&rt)) {
        return functions::lists::plan::concat_operator(l, r);
    }
    let sig = binary_signature(op, &lt, &rt)?;
    if op == Operator::StringConcat {
        l = to_utf8(l)?;
        r = to_utf8(r)?;
        return Ok(PhysExpr::Binary { left: Box::new(l), op, right: Box::new(r), dt: DataType::Utf8 });
    }
    let l = cast_expr(l, &sig.left)?;
    let r = cast_expr(r, &sig.right)?;
    Ok(PhysExpr::Binary { left: Box::new(l), op, right: Box::new(r), dt: sig.result })
}

fn compile_in_list(expr: &Expr, list: &[Expr], negated: bool, schema: &PlanSchema) -> Result<PhysExpr> {
    let c = create_physical_expr(expr, schema)?;
    let ct = c.data_type();
    let items = list.iter().map(|e| create_physical_expr(e, schema)).collect::<Result<Vec<_>>>()?;
    let all_lit = items.iter().all(|i| matches!(i, PhysExpr::Literal(_)));
    let int_like = ct.is_integer() || matches!(ct, DataType::Date32);
    if all_lit && items.len() > 2 && (int_like || is_string(&ct)) {
        let mut has_null = false;
        let mut ints = HashSet::new();
        let mut strs = HashSet::new();
        let mut ok = true;
        for i in &items {
            let PhysExpr::Literal(s) = i else { unreachable!() };
            if s.is_null() {
                has_null = true;
                continue;
            }
            match s.cast_exact(&ct) {
                Some(v) if int_like => match v.cast_to(&DataType::Int64).ok().and_then(|x| x.as_i64()) {
                    Some(x) => {
                        ints.insert(x);
                    }
                    None => ok = false,
                },
                Some(v) => match v.cast_to(&DataType::Utf8).ok().and_then(|x| x.as_str().map(|s| s.into())) {
                    Some(x) => {
                        strs.insert(x);
                    }
                    None => ok = false,
                },
                None => {
                    // literal not representable in the column type: can never match
                    if is_string(s.data_type()) != is_string(&ct) {
                        ok = false;
                    }
                }
            }
        }
        if ok {
            let set = if int_like { InSet::Int(ints) } else { InSet::Str(strs) };
            return Ok(PhysExpr::InList { expr: Box::new(c), set: Arc::new(set), has_null, negated });
        }
    }
    // general case: OR of equalities
    let mut acc: Option<Expr> = None;
    for e in list {
        let eq = expr.clone().eq(e.clone());
        acc = Some(match acc {
            None => eq,
            Some(a) => a.or(eq),
        });
    }
    let acc = acc.unwrap_or(Expr::Literal(Scalar::boolean(false)));
    let acc = if negated { acc.not() } else { acc };
    create_physical_expr(&acc, schema)
}

fn compile_function(func: ScalarFunc, args: &[Expr], schema: &PlanSchema) -> Result<PhysExpr> {
    use ScalarFunc::*;
    let mut a = args.iter().map(|e| create_physical_expr(e, schema)).collect::<Result<Vec<_>>>()?;
    // len / reverse / contains / .. of a list are the list functions
    if let Some(list_func) = a.first().and_then(|x| functions::lists::names::list_variant(func, &x.data_type())) {
        return functions::lists::plan::compile(list_func, args, schema);
    }
    let nargs = |lo: usize, hi: usize| -> Result<()> {
        if args.len() < lo || args.len() > hi {
            Err(WhError::Plan(format!("{} expects {lo}..{hi} arguments, got {}", func.name(), args.len())))
        } else {
            Ok(())
        }
    };
    match func {
        Abs | Ceil | Floor => {
            nargs(1, 1)?;
            if !is_numeric(&a[0].data_type()) {
                a[0] = cast_expr(a.remove(0), &DataType::Float64)?;
            }
        }
        Round => {
            nargs(1, 2)?;
            a[0] = cast_expr(a[0].clone(), &DataType::Float64)?;
            if a.len() == 2 {
                a[1] = cast_expr(a[1].clone(), &DataType::Int64)?;
            }
        }
        Sqrt | Exp | Ln | Log10 | Log2 => {
            nargs(1, 1)?;
            a[0] = cast_expr(a[0].clone(), &DataType::Float64)?;
        }
        Power => {
            nargs(2, 2)?;
            a[0] = cast_expr(a[0].clone(), &DataType::Float64)?;
            a[1] = cast_expr(a[1].clone(), &DataType::Float64)?;
        }
        Upper | Lower | Length | Trim | LTrim | RTrim | Reverse => {
            nargs(1, 1)?;
            a[0] = to_utf8(a[0].clone())?;
        }
        Substring => {
            nargs(2, 3)?;
            a[0] = to_utf8(a[0].clone())?;
            for i in 1..a.len() {
                a[i] = cast_expr(a[i].clone(), &DataType::Int64)?;
            }
        }
        Left | Right => {
            nargs(2, 2)?;
            a[0] = to_utf8(a[0].clone())?;
            a[1] = cast_expr(a[1].clone(), &DataType::Int64)?;
        }
        Replace => {
            nargs(3, 3)?;
            for x in a.iter_mut() {
                *x = to_utf8(x.clone())?;
            }
        }
        Concat => {
            for x in a.iter_mut() {
                *x = to_utf8(x.clone())?;
            }
        }
        StrPos => {
            nargs(2, 2)?;
            a[0] = to_utf8(a[0].clone())?;
            a[1] = to_utf8(a[1].clone())?;
        }
        StartsWith | EndsWith | Contains => {
            nargs(2, 2)?;
            if !is_string(&a[0].data_type()) {
                a[0] = to_utf8(a[0].clone())?;
            }
            let t = a[0].data_type();
            a[1] = cast_expr(a[1].clone(), &t)?;
        }
        Coalesce | Greatest | Least | NullIf => {
            if func == NullIf {
                nargs(2, 2)?;
            } else {
                nargs(1, usize::MAX)?;
            }
            let types: Vec<DataType> = a.iter().map(|x| x.data_type()).collect();
            let t = common_supertype(types.iter())
                .ok_or_else(|| WhError::Plan(format!("{}: incompatible types {types:?}", func.name())))?;
            for x in a.iter_mut() {
                *x = cast_expr(x.clone(), &t)?;
            }
        }
        Year | Quarter | Month | Week | Day | DayOfWeek | DayOfYear | Hour | Minute | Second => {
            nargs(1, 1)?;
            let t = a[0].data_type();
            if is_string(&t) {
                a[0] = cast_expr(a[0].clone(), &DataType::Timestamp(TimeUnit::Microsecond, None))?;
            } else if !is_temporal(&t) {
                return Err(WhError::Plan(format!("{} requires a temporal argument, got {t}", func.name())));
            }
        }
        DateTrunc => {
            nargs(2, 2)?;
            if !matches!(a[0], PhysExpr::Literal(_)) {
                return Err(WhError::NotSupported("date_trunc unit must be a constant".into()));
            }
        }
        _ => return functions::plan::compile(func, args, schema),
    }
    let types: Vec<DataType> = a.iter().map(|x| x.data_type()).collect();
    let dt = func.return_type(&types)?;
    Ok(PhysExpr::Function { func, args: a, dt })
}

impl fmt::Display for PhysExpr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PhysExpr::Column { index, name, .. } => write!(f, "{name}@{index}"),
            PhysExpr::Literal(s) => write!(f, "{s}"),
            PhysExpr::Binary { left, op, right, .. } => write!(f, "({left} {} {right})", op.symbol()),
            PhysExpr::Not(e) => write!(f, "NOT {e}"),
            PhysExpr::Negative(e) => write!(f, "-{e}"),
            PhysExpr::IsNull(e) => write!(f, "{e} IS NULL"),
            PhysExpr::IsNotNull(e) => write!(f, "{e} IS NOT NULL"),
            PhysExpr::Cast { expr, to, .. } => write!(f, "CAST({expr} AS {to})"),
            PhysExpr::Case { .. } => write!(f, "CASE(..)"),
            PhysExpr::InList { expr, negated, .. } => {
                write!(f, "{expr} {}IN (<set>)", if *negated { "NOT " } else { "" })
            }
            PhysExpr::Like { expr, pattern, negated, .. } => {
                write!(f, "{expr} {}LIKE {pattern}", if *negated { "NOT " } else { "" })
            }
            PhysExpr::Function { func, args, .. } => write!(
                f,
                "{}({})",
                func.name(),
                args.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ")
            ),
        }
    }
}

/// Evaluate a column-free logical expression to a scalar (constant folding).
pub fn evaluate_constant(e: &Expr) -> Result<Option<Scalar>> {
    let schema = PlanSchema::empty();
    match create_physical_expr(e, &schema) {
        Ok(PhysExpr::Literal(s)) => Ok(Some(s)),
        Ok(_) => Ok(None),
        Err(WhError::ColumnNotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod null_as_false_tests;
