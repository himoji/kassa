import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";

import { List, Row, Text, ThemeProvider } from "@/components/ui";

type Item = { id: string; title: string };

const ITEMS: Item[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Bravo" },
  { id: "c", title: "Charlie" },
];

/** `Divider` is not an accessibility element, so count it in the rendered tree. */
function separatorCount(): number {
  return (JSON.stringify(screen.toJSON()).match(/"role":"separator"/g) ?? []).length;
}

describe("@/components/ui List", () => {
  it("renders one item per datum", async () => {
    await render(
      <ThemeProvider>
        <List data={ITEMS} renderItem={(item) => <Row title={item.title} />} />
      </ThemeProvider>
    );

    for (const item of ITEMS) expect(screen.getByText(item.title)).toBeTruthy();
  });

  it("draws a separator between items but not after the last one", async () => {
    await render(
      <ThemeProvider>
        <List data={ITEMS} renderItem={(item) => <Row title={item.title} />} />
      </ThemeProvider>
    );

    expect(separatorCount()).toBe(ITEMS.length - 1);
  });

  it("draws no separator when separator is false", async () => {
    await render(
      <ThemeProvider>
        <List data={ITEMS} separator={false} renderItem={(item) => <Row title={item.title} />} />
      </ThemeProvider>
    );

    expect(separatorCount()).toBe(0);
  });

  it("renders a custom separator node", async () => {
    await render(
      <ThemeProvider>
        <List
          data={ITEMS}
          separator={<Text>-</Text>}
          renderItem={(item) => <Row title={item.title} />}
        />
      </ThemeProvider>
    );

    expect(screen.getAllByText("-")).toHaveLength(ITEMS.length - 1);
    expect(separatorCount()).toBe(0);
  });

  it("renders the empty node only when data is empty", async () => {
    const empty = <Text>Nothing here</Text>;
    const { rerender } = await render(
      <ThemeProvider>
        <List data={[]} empty={empty} renderItem={(item: Item) => <Row title={item.title} />} />
      </ThemeProvider>
    );
    expect(screen.getByText("Nothing here")).toBeTruthy();

    await rerender(
      <ThemeProvider>
        <List data={ITEMS} empty={empty} renderItem={(item) => <Row title={item.title} />} />
      </ThemeProvider>
    );
    expect(screen.queryByText("Nothing here")).toBeNull();
  });

  it("renders the header and footer", async () => {
    await render(
      <ThemeProvider>
        <List
          data={ITEMS}
          header={<Text>Head</Text>}
          footer={<Text>Foot</Text>}
          renderItem={(item) => <Row title={item.title} />}
        />
      </ThemeProvider>
    );

    expect(screen.getByText("Head")).toBeTruthy();
    expect(screen.getByText("Foot")).toBeTruthy();
  });

  it("uses the keyExtractor it is given", async () => {
    const keyExtractor = jest.fn((item: Item) => item.id);
    await render(
      <ThemeProvider>
        <List
          data={ITEMS}
          keyExtractor={keyExtractor}
          renderItem={(item) => <Row title={item.title} />}
        />
      </ThemeProvider>
    );

    // FlatList may re-key an item while it measures, so only the mapping matters.
    expect(keyExtractor).toHaveBeenCalledWith(ITEMS[0], 0);
    expect(keyExtractor).toHaveBeenCalledWith(ITEMS[2], 2);
  });

  it("keys off item.id, then the index, when no keyExtractor is given", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    // Same `id` shape and a shape with no id at all: neither may collide.
    await render(
      <ThemeProvider>
        <List data={ITEMS} renderItem={(item) => <Row title={item.title} />} />
      </ThemeProvider>
    );
    await render(
      <ThemeProvider>
        <List data={["one", "two", "three"]} renderItem={(item) => <Row title={item} />} />
      </ThemeProvider>
    );

    expect(screen.getByText("three")).toBeTruthy();
    expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
    error.mockRestore();
  });
});
