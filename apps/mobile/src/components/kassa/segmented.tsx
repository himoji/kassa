import { SegmentedControl } from "@expo/ui/community/segmented-control";

/**
 * Native segmented control (UISegmentedControl on iOS, Material 3 segmented buttons on Android,
 * vendored JS control on web) for non-navigational view switching; at most 4 segments (HIG).
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <SegmentedControl
      values={options.map((o) => o.label)}
      selectedIndex={Math.max(
        0,
        options.findIndex((o) => o.value === value)
      )}
      onChange={(e) => {
        const next = options[e.nativeEvent.selectedSegmentIndex];
        if (next) onChange(next.value);
      }}
      style={{ minHeight: 36 }}
    />
  );
}
