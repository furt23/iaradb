import { redirect } from "next/navigation";

import { tableHref } from "@/features/data/links";

/** The catalog moved to the Data section. */
export default async function CatalogTablePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  redirect(tableHref(decodeURIComponent(name)));
}
