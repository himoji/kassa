// @testing-library/react-native v14 registers its jest matchers automatically;
// there is no "extend-expect" entry to import.
import { jest } from "@jest/globals";

// In-memory stand-in for expo-sqlite/kv-store so stores can be tested without a native DB.
// `virtual`: expo-sqlite is absent when another storage module is selected.
jest.mock(
  "expo-sqlite/kv-store",
  () => {
    const store = new Map<string, string>();
    const Storage = {
      getItem: (key: string) => Promise.resolve(store.get(key) ?? null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
      removeItem: (key: string) => {
        store.delete(key);
        return Promise.resolve();
      },
      getItemAsync: (key: string) => Promise.resolve(store.get(key) ?? null),
      setItemAsync: (key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
      removeItemAsync: (key: string) => {
        const existed = store.delete(key);
        return Promise.resolve(existed);
      },
      getItemSync: (key: string) => store.get(key) ?? null,
      setItemSync: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItemSync: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
        return Promise.resolve();
      },
      clearSync: () => {
        store.clear();
      },
      getAllKeys: () => Promise.resolve([...store.keys()]),
      getAllKeysAsync: () => Promise.resolve([...store.keys()]),
      getAllKeysSync: () => [...store.keys()],
      clearAsync: () => {
        store.clear();
        return Promise.resolve(true);
      },
    };
    return { __esModule: true, default: Storage, Storage };
  },
  { virtual: true }
);

// Native animation / haptics / symbols have no JS-only implementation under jest.
// reanimated ships an official mock; it needs the react-native-worklets jest resolver (jest.config.js).
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
jest.mock("expo-haptics", () => ({
  impactAsync: jest.fn(() => Promise.resolve()),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
}));
jest.mock("expo-symbols", () => ({ SymbolView: () => null }));

// Pressto presses through a gesture-handler button on the UI thread; under jest a plain
// RN Pressable stands in, so `fireEvent.press` reaches `onPress` exactly as before.
jest.mock("pressto", () => {
  const React = require("react") as typeof import("react");
  const { Pressable } = require("react-native") as typeof import("react-native");
  type MockPressableProps = {
    onPress?: (options: object) => void;
    disabled?: boolean;
    metadata?: unknown;
    children?: import("react").ReactNode;
  } & Record<string, unknown>;
  const createAnimatedPressable = () =>
    function MockPressable({
      onPress,
      disabled,
      metadata: _metadata,
      children,
      ...rest
    }: MockPressableProps) {
      return React.createElement(
        Pressable,
        { ...rest, disabled, onPress: disabled ? undefined : () => onPress?.({}) },
        children
      );
    };
  return {
    createAnimatedPressable,
    PressableScale: createAnimatedPressable(),
    PressableOpacity: createAnimatedPressable(),
    PressablesConfig: ({ children }: { children?: import("react").ReactNode }) => children,
  };
});
jest.mock("react-native-keyboard-controller", () =>
  require("react-native-keyboard-controller/jest")
);
// The kit's `Sheet` is @expo/ui's native BottomSheet: render its children while presented.
jest.mock("@expo/ui", () => ({
  BottomSheet: ({
    isPresented,
    children,
  }: {
    isPresented: boolean;
    children?: import("react").ReactNode;
  }) => (isPresented ? children : null),
}));

// `virtual` keeps this mock valid when the i18n module (and expo-localization) is not selected.
jest.mock(
  "expo-localization",
  () => ({ getLocales: () => [{ languageCode: "en", languageTag: "en-US" }] }),
  { virtual: true }
);

// expo-crypto's auto-mock returns undefined from randomUUID(); stores that mint ids (and the
// auth modules' nonces) need real values. `virtual`: only the auth modules pull the package in.
jest.mock(
  "expo-crypto",
  () => ({
    randomUUID: () => (require("node:crypto") as typeof import("node:crypto")).randomUUID(),
    digestStringAsync: () => Promise.resolve("digest"),
    getRandomBytesAsync: (n: number) => Promise.resolve(new Uint8Array(n)),
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  }),
  { virtual: true }
);

// Kassa native modules: passkeys and the keystore have no JS implementation under jest.
jest.mock("react-native-passkeys", () => ({
  isSupported: () => true,
  get: jest.fn(() => Promise.resolve(null)),
  create: jest.fn(() => Promise.resolve(null)),
}));
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: (k: string) => Promise.resolve(store.get(k) ?? null),
    setItemAsync: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
    deleteItemAsync: (k: string) => {
      store.delete(k);
      return Promise.resolve();
    },
  };
});

// Mocks the UI components need under jest (native style engines, …).
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./src/components/ui/jest-setup");

// expo installs `fetch` (and friends) as lazy globals (expo/src/winter/installGlobal.ts): the first read requires
// expo's fetch module and its native-module shims. Jest's environment teardown walks the globals, so without this
// the first read happened AFTER the tests, in teardown ("Cannot log after tests are done" from
// ExpoModulesCoreJSLogger) and, under CPU load, kept workers past Jest's exit grace period ("A worker process
// has failed to exit gracefully"). Resolve it here, while the module registry is live.
void globalThis.fetch;
