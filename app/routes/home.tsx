import { redirect } from "react-router";

export function loader() {
  throw redirect("/login");
}

export default function Home() {
  return null;
}
