import marimo

__generated_with = "iara"
app = marimo.App(width="medium")


with app.setup:
    import marimo as mo
    import iara

    ws = iara.workspace()


@app.cell(id="29mm28vo")
def _():
    import iara.functions as F
    return (F,)


@app.cell(id="nsqyy0d2")
def _():
    customer = iara.scan_parquet("D:/tpch_sf100_gen/customer.parquet")
    return (customer,)


@app.cell(id="2l54czxt")
def _():
    nation = iara.scan_parquet("D:/tpch_sf100_gen/nation.parquet")
    return (nation,)


@app.cell(id="xm3ig4xn")
def _():
    items = iara.scan_parquet("D:/tpch_sf100_gen/lineitem.parquet")
    return (items,)


@app.cell(id="rcabqlud")
def _(customer, nation):
    balance = customer.join(nation, left_on="c_nationkey", right_on="n_nationkey")
    return (balance,)


@app.cell(id="6vtweso6")
def _(F, balance):
    balance = balance.filter(
        F.col("c_comment").str.like("%account%"),
        F.col("c_mktsegment") == "AUTOMOBILE",
        F.col("c_acctbal") > 5000
    )
    return (balance,)


@app.cell(id="pmljuy5v")
def _(balance):
    balance = balance.select("c_custkey", "c_name", "n_name", "c_acctbal", "c_mktsegment", "c_comment")
    return (balance,)


@app.cell(id="cbcnn82i")
def _(balance, items):
    items_per_customer = balance.join(
        items,
        left_on=""
    )
    return (items_per_customer,)


@app.cell(id="i2pqqpxa")
def _(balance):
    balance.preview()
    return


if __name__ == "__main__":
    app.run()
