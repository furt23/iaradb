import marimo

__generated_with = "workhouse"
app = marimo.App(width="medium")


with app.setup:
    import marimo as mo
    import workhouse as wh

    ws = wh.workspace()


@app.cell(id="j5f636sc")
def _():
    mo.md(
        r"""
        # A tour of Workhouse

        Cells are **reactive**: running a cell re-runs every cell that depends on it.
        SQL cells query the workspace catalog (`workhouse.toml`) *and* DataFrames defined
        by other cells; their results become variables too.
        """
    )
    return


@app.cell(id="a88k7q9r")
def _():
    revenue_by_nation = ws.sql(
        r"""
        select
            n_name as nation,
            sum(l_extendedprice * (1 - l_discount)) as revenue,
            count(distinct o_orderkey) as orders
        from lineitem
        join orders on l_orderkey = o_orderkey
        join customer on o_custkey = c_custkey
        join nation on c_nationkey = n_nationkey
        where o_orderdate >= date '1994-01-01' and o_orderdate < date '1995-01-01'
        group by n_name
        order by revenue desc
        """,
    ).collect()
    return (revenue_by_nation,)


@app.cell(id="g2esyroi")
def _():
    from workhouse import col

    # the DataFrame API: a lazy query, shown with its profile and plan
    big_orders = (
        ws.table("orders")
        .filter(col("o_totalprice") > 300_000)
        .group_by("o_orderpriority")
        .agg(orders=col("o_orderkey").count(), avg_price=col("o_totalprice").mean())
        .sort("o_orderpriority")
    )
    big_orders
    return big_orders, col


@app.cell(id="04pwngd3")
def _(big_orders):
    priorities = ws.sql(
        r"""
        -- DataFrames from other cells are tables here
        select o_orderpriority, orders, round(avg_price, 2) as avg_price
        from big_orders
        where orders > 100
        """,
        big_orders=big_orders,
    ).collect()
    return (priorities,)


@app.cell(id="7lwec3wf")
def _(revenue_by_nation):
    top = revenue_by_nation.head(3)
    print("top nations:", ", ".join(top.to_pydict()["nation"]))
    top
    return (top,)


if __name__ == "__main__":
    app.run()
