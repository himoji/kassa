// Expo's global types (`process.env.EXPO_PUBLIC_*`, CSS/asset imports, the fetch typings),
// committed. `expo-env.d.ts` says the same, but Expo keeps it gitignored and only writes it
// on `expo start`, so a fresh clone - CI - typechecks without it.
/// <reference types="expo/types" />
