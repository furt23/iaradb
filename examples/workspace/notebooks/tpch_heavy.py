import marimo

__generated_with = "workhouse"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    import workhouse as wh
    from workhouse import col

    ws = wh.workspace()
    return col, mo, wh, ws


@app.cell
def _(mo):
    mo.md(
        r"""
        # Heavy tour: TPC-H SF10

        ~60M lineitem rows, 15M orders, 1.5M customers (`python setup_data.py --big`).
        Watch the live progress bars and the toolbar timer; **Interrupt** stops a query mid-flight.
        """
    )
    return


@app.cell
def _(ws):
    pricing = ws.sql(
        r"""
        -- full scan + aggregation over 60M rows (TPC-H Q1)
        select l_returnflag, l_linestatus,
            sum(l_quantity) as sum_qty,
            sum(l_extendedprice * (1 - l_discount)) as sum_disc_price,
            avg(l_discount) as avg_disc,
            count(*) as count_order
        from lineitem_sf10
        where l_shipdate <= date '1998-09-02'
        group by l_returnflag, l_linestatus
        order by l_returnflag, l_linestatus
        """,
    ).collect()
    return (pricing,)


@app.cell
def _(ws):
    revenue_by_year = ws.sql(
        r"""
        -- four-way join: revenue per nation and year
        select n_name as nation, extract(year from o_orderdate) as year,
            sum(l_extendedprice * (1 - l_discount)) as revenue,
            count(distinct o_orderkey) as orders
        from lineitem_sf10
        join orders_sf10 on l_orderkey = o_orderkey
        join customer_sf10 on o_custkey = c_custkey
        join nation_sf10 on c_nationkey = n_nationkey
        group by nation, year
        """,
    ).collect()
    return (revenue_by_year,)


@app.cell
def _(revenue_by_year, ws):
    growth = ws.sql(
        r"""
        -- window functions over the joined result: growth and rank per nation
        select nation, year, revenue,
            revenue / lag(revenue) over (partition by nation order by year) - 1 as growth,
            rank() over (partition by year order by revenue desc) as rank_in_year
        from revenue_by_year
        order by nation, year
        """,
        revenue_by_year=revenue_by_year,
    ).collect()
    return (growth,)


@app.cell
def _(ws):
    top_customers = ws.sql(
        r"""
        -- 1.5M customers ranked by spend, top 3 per nation (QUALIFY)
        select c_name, n_name as nation, sum(o_totalprice) as spent, count(*) as orders
        from orders_sf10
        join customer_sf10 on o_custkey = c_custkey
        join nation_sf10 on c_nationkey = n_nationkey
        group by c_name, n_name
        qualify row_number() over (partition by n_name order by sum(o_totalprice) desc) <= 3
        order by nation, spent desc
        """,
    ).collect()
    return (top_customers,)


@app.cell
def _(col, ws):
    # DataFrame API: monthly shipped volume with a 3-month rolling mean, per ship mode
    monthly = (
        ws.table("lineitem_sf10")
        .with_columns(month=col("l_shipdate").dt.month(),
                      year=col("l_shipdate").dt.year())
        .group_by("l_shipmode", "year", "month")
        .agg(qty=col("l_quantity").sum())
        .with_columns(rolling_qty=col("qty").rolling_mean(3).over("l_shipmode", order_by=["year", "month"]))
        .sort("l_shipmode", "year", "month")
    )
    monthly
    return (monthly,)


@app.cell
def _(ws):
    lines_per_order = ws.sql(
        r"""
        -- high-cardinality aggregation: 15M order keys, then a histogram
        select lines, count(*) as orders
        from (select l_orderkey, count(*) as lines from lineitem_sf10 group by l_orderkey)
        group by lines
        order by lines
        """,
    ).collect()
    return (lines_per_order,)


if __name__ == "__main__":
    app.run()
