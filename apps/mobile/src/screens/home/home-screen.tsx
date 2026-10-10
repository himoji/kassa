import { readynative } from "@/lib/readynative";
import { Box, Screen, Text } from "@/components/ui";

export function HomeScreen() {
  return (
    <Screen>
      <Box gap={2}>
        <Text variant="title">{readynative.app.name}</Text>
        <Text>Edit src/screens/home/home-screen.tsx to start building.</Text>
        <Text variant="caption">Settings has the theme switcher and your links.</Text>
      </Box>
    </Screen>
  );
}
