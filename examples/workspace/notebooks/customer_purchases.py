import marimo

__generated_with = "iara"
app = marimo.App(width="medium")


with app.setup:
    import marimo as mo
    import iara
    from iara import functions as F

    ws = iara.workspace()


@app.cell(id="bu2f5xk3")
def _():
    mo.md(
        r"""
        # Customer Purchases Report (TPC-H)

        This notebook joins the TPC-H tables (`customer`, `nation`, `orders`) to create a list of purchases organized by customer using the **Iara Python LazyFrame API**.

        Columns returned:
        - `customer_name`: Name of the customer (`c_name`)
        - `nation_name`: Nation of the customer (`n_name`)
        - `amount_of_purchases`: Number of purchases / orders (`count`)
        - `total_purchase_value`: Total amount spent across purchases (`sum(o_totalprice)`)
        - `mktsegment`: Customer market segment (`c_mktsegment`)
        - `account_balance`: Customer account balance (`c_acctbal`)
        """
    )
    return


@app.cell(id="1h3sqk3z")
def _():
    customer = iara.scan_parquet("D:/tpch_sf100_gen/customer.parquet")
    nation = iara.scan_parquet("D:/tpch_sf100_gen/nation.parquet")
    orders = iara.scan_parquet("D:/tpch_sf100_gen/orders.parquet")
    return customer, nation, orders


@app.cell(id="551ywemw")
def _(customer, nation):
    def join_customer_nation(customer: iara.LazyFrame, nation: iara.LazyFrame) -> iara.LazyFrame:
        """Enrich customer data with nation details."""
        return customer.join(
            nation,
            left_on="c_nationkey",
            right_on="n_nationkey",
            how="inner",
        )

    customer_with_nation = join_customer_nation(customer, nation)
    return customer_with_nation, join_customer_nation


@app.cell(id="xj44jqmb")
def _(customer_with_nation, orders):
    def join_customer_orders(customer_nation: iara.LazyFrame, orders: iara.LazyFrame) -> iara.LazyFrame:
        """Join customer-nation records with their placed orders."""
        return customer_nation.join(
            orders,
            left_on="c_custkey",
            right_on="o_custkey",
            how="inner",
        )

    customer_orders = join_customer_orders(customer_with_nation, orders)
    return customer_orders, join_customer_orders


@app.cell(id="dmlr0b93")
def _(customer_orders):
    def aggregate_customer_purchases(joined: iara.LazyFrame) -> iara.LazyFrame:
        """Group by customer attributes and calculate purchase count and total value."""
        return joined.group_by(
            "c_custkey",
            "c_name",
            "n_name",
            "c_mktsegment",
            "c_acctbal",
        ).agg(
            amount_of_purchases=F.len(),
            total_purchase_value=F.col("o_totalprice").sum(),
        )

    customer_purchases_agg = aggregate_customer_purchases(customer_orders)
    return aggregate_customer_purchases, customer_purchases_agg


@app.cell(id="6wxrv0k1")
def _(customer_purchases_agg):
    def format_customer_purchases_report(aggregated: iara.LazyFrame) -> iara.LazyFrame:
        """Select and alias the requested columns, sorted by total purchase value descending."""
        return aggregated.select(
            customer_name=F.col("c_name"),
            nation_name=F.col("n_name"),
            amount_of_purchases=F.col("amount_of_purchases"),
            total_purchase_value=F.col("total_purchase_value"),
            mktsegment=F.col("c_mktsegment"),
            account_balance=F.col("c_acctbal"),
        ).sort("total_purchase_value", descending=True)

    purchases_report = format_customer_purchases_report(customer_purchases_agg)
    return format_customer_purchases_report, purchases_report


@app.cell(id="nttr79p7")
def _(
    aggregate_customer_purchases,
    format_customer_purchases_report,
    join_customer_nation,
    join_customer_orders,
):
    def get_customer_purchases(
        customer: iara.LazyFrame,
        nation: iara.LazyFrame,
        orders: iara.LazyFrame,
    ) -> iara.LazyFrame:
        """End-to-end pipeline function joining TPC-H tables to create a customer purchase summary."""
        cn = join_customer_nation(customer, nation)
        cno = join_customer_orders(cn, orders)
        agg = aggregate_customer_purchases(cno)
        return format_customer_purchases_report(agg)
    return (get_customer_purchases,)


@app.cell(id="a66a1ea6")
def _(customer, get_customer_purchases, nation, orders):
    get_customer_purchases(customer, nation, orders).preview()
    return


@app.cell(id="ifzdxatw")
def _(purchases_report):
    # Materialize and display the top results
    df = purchases_report.preview()
    return (df,)


if __name__ == "__main__":
    app.run()
