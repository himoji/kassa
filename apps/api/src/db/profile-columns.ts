import { getTableColumns } from "drizzle-orm";

import { profiles } from "./schema.ts";

/*
 * The profile columns every request needs, without the ones added for optional features (the imported money history).
 * Reading these instead of the whole row keeps /me, payments and the forecast working on a database that is one
 * migration behind (a preview deployment that skipped `db:migrate`): a new optional column can break only its own feature.
 */
const { moneyHistory: _moneyHistory, ...core } = getTableColumns(profiles);
export const PROFILE_CORE = core;
