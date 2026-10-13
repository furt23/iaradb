//! The SQL dialect: DuckDB's, plus the syntax DuckDB accepts that its sqlparser
//! dialect leaves off (`* RENAME`) and the time travel clauses of Delta tables
//! (`VERSION AS OF`, `TIMESTAMP AS OF`).

use std::any::TypeId;

use sqlparser::dialect::{Dialect, DuckDbDialect};

#[derive(Debug, Default)]
pub(super) struct WorkhouseDialect;

const BASE: DuckDbDialect = DuckDbDialect {};

impl Dialect for WorkhouseDialect {
    // the parser checks for DuckDB by type
    fn dialect(&self) -> TypeId {
        TypeId::of::<DuckDbDialect>()
    }

    fn supports_select_wildcard_rename(&self) -> bool {
        true
    }

    fn supports_table_versioning(&self) -> bool {
        true
    }

    // everything below is DuckDB's own setting
    fn supports_trailing_commas(&self) -> bool {
        BASE.supports_trailing_commas()
    }

    fn is_identifier_start(&self, ch: char) -> bool {
        BASE.is_identifier_start(ch)
    }

    fn is_identifier_part(&self, ch: char) -> bool {
        BASE.is_identifier_part(ch)
    }

    fn identifier_quote_style(&self, identifier: &str) -> Option<char> {
        BASE.identifier_quote_style(identifier)
    }

    fn supports_filter_during_aggregation(&self) -> bool {
        BASE.supports_filter_during_aggregation()
    }

    fn supports_group_by_expr(&self) -> bool {
        BASE.supports_group_by_expr()
    }

    fn supports_bitwise_shift_operators(&self) -> bool {
        BASE.supports_bitwise_shift_operators()
    }

    fn supports_named_fn_args_with_eq_operator(&self) -> bool {
        BASE.supports_named_fn_args_with_eq_operator()
    }

    fn supports_named_fn_args_with_assignment_operator(&self) -> bool {
        BASE.supports_named_fn_args_with_assignment_operator()
    }

    fn supports_dictionary_syntax(&self) -> bool {
        BASE.supports_dictionary_syntax()
    }

    fn support_map_literal_syntax(&self) -> bool {
        BASE.support_map_literal_syntax()
    }

    fn supports_lambda_functions(&self) -> bool {
        BASE.supports_lambda_functions()
    }

    fn allow_extract_single_quotes(&self) -> bool {
        BASE.allow_extract_single_quotes()
    }

    fn supports_explain_with_utility_options(&self) -> bool {
        BASE.supports_explain_with_utility_options()
    }

    fn supports_load_extension(&self) -> bool {
        BASE.supports_load_extension()
    }

    fn supports_array_typedef_with_brackets(&self) -> bool {
        BASE.supports_array_typedef_with_brackets()
    }

    fn supports_from_first_select(&self) -> bool {
        BASE.supports_from_first_select()
    }

    fn supports_order_by_all(&self) -> bool {
        BASE.supports_order_by_all()
    }

    fn supports_select_wildcard_exclude(&self) -> bool {
        BASE.supports_select_wildcard_exclude()
    }

    fn supports_notnull_operator(&self) -> bool {
        BASE.supports_notnull_operator()
    }

    fn supports_install(&self) -> bool {
        BASE.supports_install()
    }

    fn supports_detach(&self) -> bool {
        BASE.supports_detach()
    }

    fn supports_select_wildcard_replace(&self) -> bool {
        BASE.supports_select_wildcard_replace()
    }

    fn supports_comma_separated_trim(&self) -> bool {
        BASE.supports_comma_separated_trim()
    }

    fn supports_numeric_literal_underscores(&self) -> bool {
        BASE.supports_numeric_literal_underscores()
    }
}
