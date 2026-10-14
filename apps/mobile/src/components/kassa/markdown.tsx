import * as Linking from "expo-linking";
import { Fragment, useMemo, type ReactNode } from "react";
import { Text as RnText, View, type TextStyle } from "react-native";
import { Renderer, useMarkdown } from "react-native-marked";

import { useTheme } from "@/components/ui";

/** Links open through expo-linking (the library's default handler uses react-native's Linking). */
class LinkRenderer extends Renderer {
  link(
    children: string | ReactNode[],
    href: string,
    styles?: TextStyle,
    title?: string
  ): ReactNode {
    return (
      <RnText
        key={this.getKey()}
        selectable
        accessibilityRole="link"
        accessibilityLabel={title || "Link"}
        onPress={() => void Linking.openURL(href).catch(() => {})}
        style={styles}
      >
        {children}
      </RnText>
    );
  }
}

const HEADING = (fontSize: number, lineHeight: number): TextStyle => ({
  fontSize,
  lineHeight,
  fontWeight: "600",
  marginVertical: 0,
  paddingBottom: 0,
  borderBottomWidth: 0,
});

/**
 * Assistant markdown (agent chat, onboarding). Safe on partial input: react-native-marked tolerates
 * an unclosed `**` or fence, so the text can be re-rendered on every streamed delta.
 */
export function Markdown({ children }: { children: string }) {
  const { colors, mode } = useTheme();
  const renderer = useMemo(() => new LinkRenderer({ selectable: true }), []);
  const theme = useMemo(
    () => ({
      colors: {
        text: colors.foreground,
        link: colors.brandAccent,
        code: colors.background,
        border: colors.border,
      },
    }),
    [colors]
  );
  // useMarkdown memoises the parse on `children`, so unchanged text is not re-lexed.
  const nodes = useMarkdown(children, {
    renderer,
    theme,
    colorScheme: mode,
    // Chat-sized headings: a reply's "# Food budget" is a bold line, not a page title.
    styles: {
      paragraph: { paddingVertical: 0 },
      h1: HEADING(18, 24),
      h2: HEADING(17, 23),
      h3: HEADING(16, 22),
      h4: HEADING(15, 21),
    },
  });
  return (
    <View style={{ gap: 8 }}>
      {nodes.map((node, i) => (
        <Fragment key={i}>{node}</Fragment>
      ))}
    </View>
  );
}
