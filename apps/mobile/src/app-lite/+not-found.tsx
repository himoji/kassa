import { Redirect, type Href } from "expo-router";

/** An unknown `kassalite://…` link lands on Activity (or on pairing, while the phone is not paired). */
export default function NotFound() {
  return <Redirect href={"/activity" as Href} />;
}
