# Eden mobile

Eden's native iOS and Android client is an Expo SDK 54 managed app. It uses native React Native screens
and Expo Router; it does not embed the web control plane in a WebView.

## Scaffold

The app follows Expo's documented SDK 54 TypeScript + Expo Router template so it remains compatible
with the App Store build of Expo Go on physical iPhones during the SDK 57 transition:

```sh
npx create-expo-app@latest mobile --template default@sdk-54 --no-install --no-agents-md
```

Keep the generated managed/CNG structure. Do not commit generated `ios/` or `android/`
directories.

## Configure the control plane

Set `EXPO_PUBLIC_EDEN_URL` to the reachable origin of the Eden control plane, with no path:

```sh
EXPO_PUBLIC_EDEN_URL=http://localhost:5276
```

`http://localhost:5276` is the default for Expo web and an iOS simulator. A physical device needs
the computer's LAN address or the worktree's development tunnel. An Android emulator usually uses
`http://10.0.2.2:5276`. Never put secrets in an `EXPO_PUBLIC_*` variable.

## Develop

Install the control plane and mobile dependencies separately. The mobile lockfile intentionally
isolates Expo SDK 54's React 19.1 runtime from the web control plane's React 19.2 runtime:

```sh
npm install
npm --prefix mobile install
npm run mobile:start
npm run mobile:typecheck
```

From `mobile/`, `npm run ios`, `npm run android`, and `npm run web` open a platform directly.
Expo Go is useful while the app only uses Expo Go-compatible modules. Use a development build when
adding native configuration or modules unavailable in Expo Go.

## EAS

Run EAS commands from this directory:

```sh
cd mobile
npx eas-cli build --profile development --platform ios
npx eas-cli build --profile preview --platform android
npx eas-cli build --profile production --platform all
```

Deep links use the `eden://` scheme. Authentication cookies are persisted in SecureStore and API
requests send them explicitly because native fetch does not use a browser cookie jar.
