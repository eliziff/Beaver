import { Profiler } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./login/page";
import SignupPage from "./signup/page";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    signIn: vi.fn(),
    signUp: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
    useNavigate: () => mocks.push,
    Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
        <a href={to} {...props}>{children}</a>
    ),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ authLoading: false, isAuthenticated: false }),
}));
vi.mock("@/app/lib/supabase", () => ({
    getSupabase: () => ({
        auth: {
            signInWithPassword: mocks.signIn,
            signUp: mocks.signUp,
        },
    }),
}));
vi.mock("@/app/lib/beaverApi", () => ({ updateUserProfile: vi.fn() }));

describe("account forms", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.signIn.mockReturnValue(new Promise(() => {}));
        mocks.signUp.mockReturnValue(new Promise(() => {}));
    });

    it("submits login fields without rerendering on each keystroke", () => {
        let commits = 0;
        render(
            <Profiler id="login" onRender={() => commits++}>
                <LoginPage />
            </Profiler>,
        );
        const initialCommits = commits;
        fireEvent.change(screen.getByLabelText("Email"), {
            target: { value: "lawyer@example.ca" },
        });
        fireEvent.change(screen.getByLabelText("Password"), {
            target: { value: "secret" },
        });
        expect(commits).toBe(initialCommits);

        fireEvent.submit(screen.getByRole("button", { name: "Log in" }));
        expect(mocks.signIn).toHaveBeenCalledWith({
            email: "lawyer@example.ca",
            password: "secret",
        });
    });

    it("submits signup fields without rerendering on each keystroke", () => {
        let commits = 0;
        render(
            <Profiler id="signup" onRender={() => commits++}>
                <SignupPage />
            </Profiler>,
        );
        const initialCommits = commits;
        const password = "correct horse battery staple";
        const fields: [RegExp, string][] = [
            [/^Name/, "Ada"],
            [/^Organisation/, "Example LLP"],
            [/^Email$/, "ada@example.ca"],
            [/^Password$/, password],
            [/^Confirm Password$/, password],
        ];
        for (const [label, value] of fields) {
            fireEvent.change(screen.getByLabelText(label), {
                target: { value },
            });
        }
        expect(commits).toBe(initialCommits);

        fireEvent.submit(screen.getByRole("button", { name: "Sign up" }));
        expect(mocks.signUp).toHaveBeenCalledWith({
            email: "ada@example.ca",
            password,
        });
        expect(screen.getByLabelText(/^Password$/)).toHaveAttribute("minLength", "12");
    });
});
