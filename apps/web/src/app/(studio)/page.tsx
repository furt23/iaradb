import { redirect } from "next/navigation";

/** The workspace: its open notebooks, or where to start. */
export default function HomePage() {
  redirect("/notebooks");
}
