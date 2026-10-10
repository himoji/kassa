import { describe, expect, it } from "@jest/globals";
import { zodResolver } from "@hookform/resolvers/zod";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Button, ThemeProvider } from "@/components/ui";

import { Field, Form } from "..";

const schema = z.object({ email: z.email("Enter a valid email") });
type Values = z.infer<typeof schema>;

function Harness({ onValid }: { onValid: (values: Values) => void }) {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "" } });
  return (
    <ThemeProvider>
      <Form form={form}>
        <Field<Values> name="email" label="Email" placeholder="you@example.com" />
      </Form>
      <Button onPress={() => void form.handleSubmit(onValid)()}>Submit</Button>
    </ThemeProvider>
  );
}

describe("Form + Field", () => {
  it("binds the input, shows the zod error and submits valid values", async () => {
    const received: Values[] = [];
    await render(<Harness onValid={(v) => received.push(v)} />);

    const input = screen.getByPlaceholderText("you@example.com");
    await act(() => {
      fireEvent.changeText(input, "nope");
    });
    await act(() => {
      fireEvent.press(screen.getByText("Submit"));
    });
    expect(await screen.findByText("Enter a valid email")).toBeTruthy();
    expect(received).toHaveLength(0);

    await act(() => {
      fireEvent.changeText(input, "ada@example.com");
    });
    await act(() => {
      fireEvent.press(screen.getByText("Submit"));
    });
    expect(received).toEqual([{ email: "ada@example.com" }]);
  });
});
