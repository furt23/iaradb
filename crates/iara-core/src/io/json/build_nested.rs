//! Arrays and objects of a record into `List` and `Struct` columns. The
//! top-level parser hands them over as text; they are parsed here, down to
//! the scalars, into the columns of the inferred type.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{ArrayRef, ListArray, StructArray};
use arrow::buffer::{NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow::datatypes::{DataType, Field, Fields};

use super::build::Column;
use super::parse::{Member, Parser};
use crate::error::Result;
use crate::nested::ITEM;

pub(super) struct ListColumn {
    item: Box<Column>,
    item_type: DataType,
    offsets: Vec<i32>,
    valid: Vec<bool>,
}

impl ListColumn {
    pub(super) fn new(item_type: &DataType) -> Result<Self> {
        Ok(Self { item: Box::new(Column::new(item_type)?), item_type: item_type.clone(), offsets: vec![0], valid: vec![] })
    }

    fn end_row(&mut self, valid: bool, items: usize) {
        let last = *self.offsets.last().expect("offsets start with 0");
        self.offsets.push(last + items as i32);
        self.valid.push(valid);
    }

    pub(super) fn push_null(&mut self) {
        self.end_row(false, 0);
    }

    /// The elements of the array `text`.
    pub(super) fn push_array(&mut self, text: &str, name: &str) -> Result<()> {
        let mut p = Parser::new(text.as_bytes());
        let (mut items, mut more) = (0, p.array_open()?);
        while more {
            self.item.push(Some(&p.value()?), name)?;
            items += 1;
            more = p.array_next()?;
        }
        self.end_row(true, items);
        Ok(())
    }

    pub(super) fn finish(&mut self) -> Result<ArrayRef> {
        let items = self.item.finish()?;
        let offsets = OffsetBuffer::new(ScalarBuffer::from(std::mem::replace(&mut self.offsets, vec![0])));
        let valid = std::mem::take(&mut self.valid);
        let nulls = valid.iter().any(|v| !v).then(|| NullBuffer::from(valid));
        let field = Arc::new(Field::new(ITEM, self.item_type.clone(), true));
        Ok(Arc::new(ListArray::try_new(field, offsets, items, nulls)?))
    }
}

pub(super) struct StructColumn {
    fields: Fields,
    children: Vec<Column>,
    index: HashMap<String, usize>,
    valid: Vec<bool>,
}

impl StructColumn {
    pub(super) fn new(fields: &Fields) -> Result<Self> {
        let children = fields.iter().map(|f| Column::new(f.data_type())).collect::<Result<Vec<_>>>()?;
        let index = fields.iter().enumerate().map(|(i, f)| (f.name().clone(), i)).collect();
        Ok(Self { fields: fields.clone(), children, index, valid: vec![] })
    }

    fn child_name(&self, name: &str, i: usize) -> String {
        format!("{name}.{}", self.fields[i].name())
    }

    pub(super) fn push_null(&mut self, name: &str) -> Result<()> {
        for i in 0..self.children.len() {
            let child = self.child_name(name, i);
            self.children[i].push(None, &child)?;
        }
        self.valid.push(false);
        Ok(())
    }

    /// The members of the object `text`; a missing member is NULL, a repeated one: the last wins.
    pub(super) fn push_object(&mut self, text: &str, name: &str) -> Result<()> {
        let mut members: Vec<Member> = vec![];
        Parser::new(text.as_bytes()).object(&mut members)?;
        let mut found: Vec<Option<usize>> = vec![None; self.children.len()];
        for (i, (k, _)) in members.iter().enumerate() {
            if let Some(&c) = self.index.get(k.as_ref()) {
                found[c] = Some(i);
            }
        }
        for c in 0..self.children.len() {
            let child = self.child_name(name, c);
            self.children[c].push(found[c].map(|i| &members[i].1), &child)?;
        }
        self.valid.push(true);
        Ok(())
    }

    pub(super) fn finish(&mut self) -> Result<ArrayRef> {
        let arrays = self.children.iter_mut().map(Column::finish).collect::<Result<Vec<_>>>()?;
        let valid = std::mem::take(&mut self.valid);
        let nulls = valid.iter().any(|v| !v).then(|| NullBuffer::from(valid));
        Ok(Arc::new(StructArray::try_new(self.fields.clone(), arrays, nulls)?))
    }
}
