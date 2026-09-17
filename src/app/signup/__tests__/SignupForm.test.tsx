/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SignupForm from "../SignupForm";

const realFetch = global.fetch;
afterAll(() => { global.fetch = realFetch; });

function resp(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

it("submits org + email to /api/signup and shows the success message", async () => {
  const fetchMock = jest.fn().mockResolvedValue(resp(201, { message: "Registered and queued." }));
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<SignupForm />);
  fireEvent.change(screen.getByTestId("signup-org"), { target: { value: "Acme Inc" } });
  fireEvent.change(screen.getByTestId("signup-email"), { target: { value: "a@acme.com" } });
  await act(async () => { fireEvent.click(screen.getByTestId("signup-submit")); });

  await waitFor(() => expect(screen.getByTestId("signup-result")).toHaveTextContent("Registered and queued."));
  const [url, opts] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/signup");
  expect(JSON.parse((opts as { body: string }).body)).toEqual({ orgName: "Acme Inc", adminEmail: "a@acme.com" });
});

it("shows the server's message on a rejected signup", async () => {
  global.fetch = jest.fn().mockResolvedValue(resp(400, { message: "Enter a valid admin email." })) as unknown as typeof fetch;
  render(<SignupForm />);
  fireEvent.change(screen.getByTestId("signup-org"), { target: { value: "Acme" } });
  fireEvent.change(screen.getByTestId("signup-email"), { target: { value: "x@y.z" } });
  await act(async () => { fireEvent.click(screen.getByTestId("signup-submit")); });
  await waitFor(() => expect(screen.getByTestId("signup-result")).toHaveTextContent("Enter a valid admin email."));
});

it("submit is disabled until both fields are filled", () => {
  render(<SignupForm />);
  expect(screen.getByTestId("signup-submit")).toBeDisabled();
});
