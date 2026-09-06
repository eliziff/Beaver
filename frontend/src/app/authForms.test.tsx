import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./login/page";
import SignupPage from "./signup/page";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
    refreshSession: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
    useNavigate: () => mocks.push,
    useLocation: () => ({ search: "" }),
    Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
        <a href={to} {...props}>{children}</a>
    ),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        authLoading: false,
        isAuthenticated: false,
        refreshSession: mocks.refreshSession,
    }),
}));
vi.mock("@/app/lib/api/auth", () => ({
    login: (...args: unknown[]) => mocks.signIn(...args),
    signup: (...args: unknown[]) => mocks.signUp(...args),
    googleSignIn: vi.fn(),
}));
vi.mock("@/app/lib/api/account", () => ({
  updateUserProfile: vi.fn()
}));

describe("account forms", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.signIn.mockResolvedValue({ user: {} });
        mocks.signUp.mockResolvedValue({ user: {}, requiresEmailConfirmation: true });
        mocks.refreshSession.mockResolvedValue({});
    });

    it("submits login credentials", async () => {
        render(<LoginPage />);
        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "lawyer@example.ca" },
        });
        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "secret" },
        });
        fireEvent.submit(screen.getByRole("button", { name: "Log in" }));
        await waitFor(() => expect(mocks.signIn).toHaveBeenCalledWith(
            "lawyer@example.ca", "secret",
        ));
    });

    it("submits signup details", async () => {
        render(<SignupPage />);
        const password = "correct horse battery staple";
        const fields: [RegExp, string][] = [
            [/^Name/, "Ada"],
            [/^Organisation/, "Example LLP"],
            [/^Email$/, "ada@example.ca"],
            [/^Password$/, password],
            [/^Confirm password$/, password],
        ];
        for (const [label, value] of fields) {
            fireEvent.change(screen.getByLabelText(label), {
                target: { value },
            });
        }
        fireEvent.submit(screen.getByRole("button", { name: "Sign up" }));
        await waitFor(() => expect(mocks.signUp).toHaveBeenCalledWith({
            email: "ada@example.ca",
            password,
            displayName: "Ada",
            organisation: "Example LLP",
        }, "/onboarding"));
        expect(screen.getByLabelText(/^Password$/)).toHaveAttribute("minLength", "12");
    });
});
