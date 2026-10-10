/** `gen screen` / `gen module` scaffolders. */
import fs from "node:fs";
import path from "node:path";

import { CATALOG, isCategory, isOption, type Category } from "./catalog.ts";
import type { ModuleJsonInput } from "./schema.ts";

export function toKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function toPascal(name: string): string {
  return toKebab(name)
    .split("-")
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join("");
}

function writeNew(root: string, rel: string, content: string, created: string[]): void {
  const abs = path.join(root, rel);
  if (fs.existsSync(abs)) throw new Error(`${rel} already exists`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  created.push(rel);
}

export function toTitle(name: string): string {
  return toKebab(name)
    .split("-")
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join(" ");
}

/** Marker comments the generators anchor their inserts on. */
export const TABS_MARKER = "{/* gen:tabs */}";
export const STACK_MARKER = "{/* gen:stack */}";

const TABS_LAYOUT = "src/app/(tabs)/_layout.tsx";
const ROOT_LAYOUT = "src/app/_layout.tsx";
const LOCALES_DIR = "src/locales";

/** SF Symbol + its Material counterpart (expo-symbols renders `fallback` on Android/web). */
export const DEFAULT_TAB_ICON = "square.grid.2x2";
export const DEFAULT_TAB_ICON_FALLBACK = "grid_view";

export interface GenScreenOptions {
  /** Route under `src/app/(tabs)/` and a `<Tabs.Screen>` entry in the tabs layout. */
  tab?: boolean;
  /** Route group under `src/app/<name>/` presented modally. */
  modal?: boolean;
  icon?: string;
  iconFallback?: string;
  title?: string;
}

export interface GenScreenResult {
  created: string[];
  /** Existing files the generator edited (layouts, locales). */
  updated: string[];
  /** Non-fatal: a marker was missing, with the block to paste by hand. */
  warnings: string[];
}

function screenFile(name: string, component: string): string {
  return `import { Screen, Text } from "@/components/ui";

export function ${component}() {
  return (
    <Screen>
      <Text variant="title">${toTitle(name)}</Text>
    </Screen>
  );
}
`;
}

function routeFile(name: string, component: string): string {
  return `import { ${component} } from "@/screens/${name}/${name}-screen";

export default function Route() {
  return <${component} />;
}
`;
}

/** Inserts `block` just before `marker`, keeping the marker for the next run. */
function insertAtMarker(
  root: string,
  rel: string,
  marker: string,
  block: string,
  result: GenScreenResult,
  what: string
): void {
  const abs = path.join(root, rel);
  const source = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const at = source.indexOf(marker);
  if (at === -1) {
    result.warnings.push(`${rel}: no \`${marker}\` marker - add ${what} by hand:\n\n${block}\n`);
    return;
  }
  const lineStart = source.lastIndexOf("\n", at) + 1;
  const indent = source.slice(lineStart, at);
  const indented = block
    .split("\n")
    .map((line) => (line ? indent + line : line))
    .join("\n");
  fs.writeFileSync(abs, source.slice(0, lineStart) + indented + "\n" + source.slice(lineStart));
  result.updated.push(rel);
}

function tabScreenBlock(
  name: string,
  title: string,
  icon: string,
  fallback: string,
  localised: boolean
): string {
  return `<Tabs.Screen
  name="${name}"
  options={{
    title: ${localised ? `t(${JSON.stringify(title)})` : JSON.stringify(title)},
    tabBarIcon: ({ focused, size }) => (
      <Icon
        name="${icon}"
        fallback="${fallback}"
        size={size}
        color={focused ? "primary" : "mutedForeground"}
      />
    ),
  }}
/>`;
}

/** The shipped native tab bar: one `<NativeTabs.Trigger>` per tab, SF Symbol + Material icon. */
function nativeTabTriggerBlock(
  name: string,
  title: string,
  icon: string,
  fallback: string,
  localised: boolean
): string {
  const label = localised ? `{t(${JSON.stringify(title)})}` : title;
  return `<NativeTabs.Trigger name="${name}">
  <NativeTabs.Trigger.Icon sf="${icon}" md="${fallback}" />
  <NativeTabs.Trigger.Label>${label}</NativeTabs.Trigger.Label>
</NativeTabs.Trigger>`;
}

function readTabsLayout(root: string): string {
  const abs = path.join(root, TABS_LAYOUT);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
}

/** True when the tabs layout localises titles (`t("…")`) rather than using plain strings. */
function tabsLayoutLocalises(root: string): boolean {
  const source = readTabsLayout(root);
  return /title:\s*t\(/.test(source) || /\{t\("/.test(source);
}

/**
 * Adds `title` to every `src/locales/<lang>.json`. Keys are the English source
 * strings (`keySeparator: false` in `src/lib/i18n.ts`), so the key is the title
 * itself; other locales get the English value to translate later, and never a
 * missing key. Existing key order is preserved; the new key is appended.
 */
function addLocaleKey(root: string, title: string, result: GenScreenResult): void {
  const dir = path.join(root, LOCALES_DIR);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith(".json")) continue;
    const rel = `${LOCALES_DIR}/${entry}`;
    const abs = path.join(dir, entry);
    const messages = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, string>;
    if (title in messages) continue;
    messages[title] = title;
    fs.writeFileSync(abs, JSON.stringify(messages, null, 2) + "\n");
    result.updated.push(rel);
  }
}

function modalLayoutFile(name: string, component: string): string {
  return `import { Stack } from "expo-router";

import { useTheme } from "@/components/ui";

/** \`/${name}\` is presented as a modal over whatever pushed it. */
export default function ${component}Layout() {
  const { colors } = useTheme();

  return (
    <>
      <Stack.Screen options={{ presentation: "modal", headerShown: false }} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </>
  );
}
`;
}

export function genScreen(
  root: string,
  rawName: string,
  options: GenScreenOptions = {}
): GenScreenResult {
  if (options.tab && options.modal) throw new Error("--tab and --modal are mutually exclusive");
  const name = toKebab(rawName);
  if (!name) throw new Error(`Invalid screen name "${rawName}"`);
  const component = `${toPascal(name)}Screen`;
  const result: GenScreenResult = { created: [], updated: [], warnings: [] };

  writeNew(
    root,
    `src/screens/${name}/${name}-screen.tsx`,
    screenFile(name, component),
    result.created
  );

  if (options.modal) {
    writeNew(
      root,
      `src/app/${name}/_layout.tsx`,
      modalLayoutFile(name, toPascal(name)),
      result.created
    );
    writeNew(root, `src/app/${name}/index.tsx`, routeFile(name, component), result.created);
    insertAtMarker(
      root,
      ROOT_LAYOUT,
      STACK_MARKER,
      `<Stack.Screen name="${name}" options={{ presentation: "modal" }} />`,
      result,
      "the modal route"
    );
    return result;
  }

  if (!options.tab) {
    writeNew(root, `src/app/${name}.tsx`, routeFile(name, component), result.created);
    return result;
  }

  writeNew(root, `src/app/(tabs)/${name}.tsx`, routeFile(name, component), result.created);
  const title = options.title ?? toTitle(name);
  const localised = tabsLayoutLocalises(root);
  insertAtMarker(
    root,
    TABS_LAYOUT,
    TABS_MARKER,
    (readTabsLayout(root).includes("<NativeTabs") ? nativeTabTriggerBlock : tabScreenBlock)(
      name,
      title,
      options.icon ?? DEFAULT_TAB_ICON,
      options.iconFallback ?? DEFAULT_TAB_ICON_FALLBACK,
      localised
    ),
    result,
    "the tab"
  );
  if (localised) addLocaleKey(root, title, result);
  return result;
}

export function genModule(root: string, category: string, option: string): string[] {
  if (!isCategory(category)) {
    throw new Error(
      `Unknown category "${category}" (expected ${Object.keys(CATALOG).join(" | ")})`
    );
  }
  if (!isOption(category as Category, option)) {
    throw new Error(
      `"${option}" is not a ${category} option (expected ${CATALOG[category as Category].join(" | ")}); add it to scripts/lib/catalog.ts first`
    );
  }
  const dir = `modules/${category}/${option}`;
  if (fs.existsSync(path.join(root, dir))) throw new Error(`${dir} already exists`);
  const def: ModuleJsonInput = {
    id: option,
    category,
    label: option,
    hint: "",
    expoGo: true,
    dependencies: {},
    devDependencies: {},
    expoInstall: [],
    package: {},
    app: { expo: {} },
    tsconfig: { include: [] },
    files: [],
    removeFiles: [],
    providers: [],
    env: [],
    requires: {},
    recommends: {},
    conflicts: [],
    gen: [],
    doctor: [],
    postSetup: [],
  };
  const created: string[] = [];
  writeNew(root, `${dir}/module.json`, JSON.stringify(def, null, 2) + "\n", created);
  writeNew(root, `${dir}/files/.gitkeep`, "", created);
  writeNew(
    root,
    `${dir}/docs.md`,
    `# ${option} (${category})

What this module adds, which env keys it needs and where to get them.

## Setup

\`\`\`sh
bun run setup --${category} ${option}
\`\`\`
`,
    created
  );
  return created;
}
