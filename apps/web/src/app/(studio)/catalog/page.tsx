import { redirect } from "next/navigation";

/** The catalog moved to the Data section. */
export default function CatalogPage() {
  redirect("/data");
}
