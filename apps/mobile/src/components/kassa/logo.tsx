import { View } from "react-native";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

import { Text } from "@/components/ui";

/** The product name: a wordmark, never translated. */
const WORDMARK = "Kassa";

/** The Kassa mark (assets/brand/logo-mark.svg): a K whose arm ends in a coin. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024">
      <Defs>
        <LinearGradient id="kassa-mark" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#14B886" />
          <Stop offset="1" stopColor="#056347" />
        </LinearGradient>
      </Defs>
      <Rect width={1024} height={1024} rx={232} fill="url(#kassa-mark)" />
      <Rect x={292} y={276} width={118} height={472} rx={59} fill="#fff" />
      <Path
        d="M618 394 L500 512 L716 728"
        fill="none"
        stroke="#fff"
        strokeWidth={118}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={738} cy={276} r={66} fill="#C6F6D5" />
    </Svg>
  );
}

/** Mark + wordmark, for the welcome screen and the web sidebar. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={WORDMARK}
      style={{ flexDirection: "row", alignItems: "center", gap: size * 0.3 }}
    >
      <LogoMark size={size} />
      <Text style={{ fontSize: size * 0.68, fontWeight: "700", letterSpacing: -0.4 }}>
        {WORDMARK}
      </Text>
    </View>
  );
}
