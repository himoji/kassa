import { DataScreen } from "@/screens/settings/data-screen";

/** Export works here; erasing needs the passkey, so the server sends it to the web app (428). */
export default function Route() {
  return <DataScreen />;
}
