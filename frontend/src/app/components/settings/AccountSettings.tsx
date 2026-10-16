import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, Download, LogOut, Trash2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Switch } from "@/app/components/ui/switch";
import { Modal } from "@/app/components/modals/Modal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { VerificationCodeInput } from "@/app/components/popups/MfaVerificationPopup";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { deleteAccount, deleteAllChats, deleteAllProjects, deleteAllTabularReviews, exportAccountData,
    exportChatData, exportTabularReviewsData } from "@/app/lib/api/account";
import { challengeMfa, enrollMfa, getMfaAssurance, listMfaFactors, unenrollMfa, updateAuthPassword,
    verifyMfa } from "@/app/lib/api/auth";
import { downloadBlob } from "@/app/lib/download";
import { errorMessage } from "@/app/lib/utils";
import { AccountSection, SettingRow, SettingsSection, accountGlassDangerOutlineButtonClassName,
    accountGlassInputClassName, accountGlassPrimaryButtonClassName } from "./AccountSection";

type DeleteAction = "chats" | "tabular-reviews" | "projects" | "account";
const EXPORTS = [
    { action: "export-chats", title: "Export chats", description: "Assistant and review chat history as JSON.", file: "beaver-chat-export.json", run: exportChatData },
    { action: "export-tabular-reviews", title: "Export tabular reviews", description: "Owned reviews, cells, and review chats as JSON.", file: "beaver-tabular-reviews-export.json", run: exportTabularReviewsData },
    { action: "export-account", title: "Export account", description: "Account, project, document, workflow, and review data as JSON.", file: "beaver-account-export.json", run: exportAccountData },
] as const;
const DELETES: { action: DeleteAction; title: string; message: string }[] = [
    { action: "chats", title: "Delete all chats", message: "This permanently deletes assistant and review chat history." },
    { action: "tabular-reviews", title: "Delete all tabular reviews", message: "This permanently deletes reviews you own, including cells and review chats." },
    { action: "projects", title: "Delete all projects", message: "This permanently deletes projects you own, including documents, chats, and reviews." },
    { action: "account", title: "Delete account", message: "This permanently deletes your account and personal data. Organization work stays with a remaining admin. Choose another admin first if you are the last one." },
];
const fieldClass = "mt-2 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
const linkButton = "text-xs font-medium text-gray-700 hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400";

/** Email, password, two-factor verification, data export and deletion, signing out. */
export function AccountSettings() {
    const navigate = useNavigate();
    const { user, signOut, updateEmail } = useAuth();
    const { loadChats } = useChatHistoryContext();
    const { runMfa, mfaPopup } = useMfaAction();
    const [busy, setBusy] = useState<string | null>(null);
    const [emailStatus, setEmailStatus] = useState<string | null>(null);
    const [emailWarning, setEmailWarning] = useState<string | null>(null);
    const [warning, setWarning] = useState<string | null>(null);
    const [pendingDelete, setPendingDelete] = useState<DeleteAction | null>(null);
    const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
    const leave = async () => { await signOut(); navigate("/"); };
    const work = (key: string, action: () => Promise<void>) => async () => {
        setBusy(key);
        try { await action(); } finally { setBusy(null); }
    };

    function saveEmail(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem("email") as HTMLInputElement;
        const next = input.value.trim();
        if (!next || next === user?.email) return;
        setEmailStatus(null); setEmailWarning(null);
        void runMfa(work("email", async () => {
            const updated = await updateEmail(next);
            setEmailStatus(updated.pendingEmail
                ? `Confirmation sent to ${updated.pendingEmail}. Your current email remains ${updated.email} until the change is confirmed.`
                : "Email updated.");
        }), {
            title: "Two-factor verification required",
            message: "Email changes are sensitive. Enter a code from your authenticator app to continue.",
            onError: (error) => {
                const message = errorMessage(error, "Failed to update email. Please try again.");
                if (!message.toLowerCase().includes("a user with this email address has already been registered")) {
                    setEmailStatus(message); return;
                }
                input.value = user?.pendingEmail || user?.email || "";
                setEmailWarning(message);
            },
        });
    }
    function savePassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = event.currentTarget, values = new FormData(form), selected = String(values.get("password") ?? "");
        if (selected !== values.get("confirmPassword")) { setPasswordStatus("Passwords do not match."); return; }
        setPasswordStatus(null);
        void runMfa(work("password", async () => {
            await updateAuthPassword(selected);
            form.reset();
            setPasswordStatus(user?.createdWithGoogle
                ? "Password set. You can now use Google or email to sign in." : "Password updated.");
        }), { onError: (error) => setPasswordStatus(errorMessage(error, "Password could not be updated.")) });
    }
    function runDelete(action: DeleteAction) {
        void runMfa(work(action, async () => {
            if (action === "account") { await deleteAccount(); await leave(); return; }
            if (action === "chats") await deleteAllChats();
            else if (action === "tabular-reviews") await deleteAllTabularReviews();
            else await deleteAllProjects();
            if (action !== "tabular-reviews") await loadChats();
            setPendingDelete(null);
        }), {
            ...(action === "account" && { title: "Two-factor verification required",
                message: "Account deletion is sensitive. Enter a code from your authenticator app to continue." }),
            onPending: () => setPendingDelete(null),
            onError: () => {
                setPendingDelete(null);
                setWarning(action === "account" ? "Failed to delete account. Please try again." : "The deletion failed. Please try again.");
            },
        });
    }
    if (!user) return null;
    const deleteCopy = DELETES.find((item) => item.action === pendingDelete);
    return <div className="space-y-6">
        <SettingsSection title="Email" action={<Button variant="outline" onClick={() => void leave()}
            className={`h-9 shrink-0 gap-1.5 text-sm ${accountGlassPrimaryButtonClassName}`}>
            <LogOut className="h-4 w-4 shrink-0" />Sign out</Button>}>
            <AccountSection className="p-4">
                <form key={user.pendingEmail || user.email} className="space-y-2" onSubmit={saveEmail}>
                    <Input name="email" type="email" aria-label="Email" defaultValue={user.pendingEmail || user.email}
                        onChange={() => { setEmailStatus(null); setEmailWarning(null); }}
                        placeholder="Enter your email" className={accountGlassInputClassName} />
                    <div className="flex items-start justify-between gap-3">
                        <p className="text-xs text-gray-500">{emailStatus ?? (user.pendingEmail && `Pending confirmation: ${user.pendingEmail}`)}</p>
                        <button type="submit" disabled={busy === "email"} className={linkButton}>{busy === "email" ? "Saving..." : "Save"}</button>
                    </div>
                </form>
            </AccountSection>
        </SettingsSection>
        <SettingsSection title={user.createdWithGoogle ? "Set a password" : "Password"}>
            <AccountSection className="p-4">
                <form className="space-y-4" onSubmit={savePassword}>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <label className="text-sm font-medium text-gray-700">New password
                            <input name="password" type="password" autoComplete="new-password" minLength={12} required className={fieldClass} /></label>
                        <label className="text-sm font-medium text-gray-700">Confirm password
                            <input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} required className={fieldClass} /></label>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                        <p aria-live="polite" className={`text-xs ${passwordStatus?.includes("could not") || passwordStatus?.includes("match") ? "text-red-700" : "text-gray-500"}`}>
                            {passwordStatus || "Use at least 12 characters."}</p>
                        <Button type="submit" disabled={busy === "password"}>{busy === "password" ? "Saving…" : "Save password"}</Button>
                    </div>
                </form>
            </AccountSection>
        </SettingsSection>
        <MfaSettings />
        <SettingsSection title="Export data">
            <AccountSection className="divide-y divide-gray-200">{EXPORTS.map((item) =>
                <ActionRow key={item.action} title={item.title} description={item.description} icon={<Download className="h-4 w-4" />}
                    label={busy === item.action ? "Exporting…" : "Export"} disabled={busy != null} className={accountGlassPrimaryButtonClassName}
                    onClick={() => void runMfa(work(item.action, async () => {
                        const result = await item.run();
                        downloadBlob(result.blob, result.filename ?? item.file);
                    }), { onError: () => setWarning("The export failed. Please try again.") })} />)}
            </AccountSection>
        </SettingsSection>
        <SettingsSection title="Delete data">
            <AccountSection className="divide-y divide-gray-200">{DELETES.map((item) =>
                <ActionRow key={item.action} title={item.title} description={item.action === "account"
                    ? "Permanently deletes your account and its data." : item.message} icon={<Trash2 className="h-4 w-4" />}
                    label="Delete" disabled={busy != null} className={accountGlassDangerOutlineButtonClassName}
                    onClick={() => setPendingDelete(item.action)} />)}
            </AccountSection>
        </SettingsSection>
        <ConfirmPopup open={!!pendingDelete} title={`${deleteCopy?.title ?? "Delete data"}?`} message={deleteCopy?.message}
            confirmLabel="Delete" confirmStatus={busy ? "loading" : "idle"} cancelLabel="Cancel"
            onCancel={() => { if (!busy) setPendingDelete(null); }} onConfirm={() => { if (pendingDelete) runDelete(pendingDelete); }} />
        <WarningPopup open={!!emailWarning} title="Email already registered" message={emailWarning} onClose={() => setEmailWarning(null)} />
        <WarningPopup open={!!warning} message={warning} onClose={() => setWarning(null)} />
        {mfaPopup}
    </div>;
}

function ActionRow({ title, description, icon, label, disabled, className, onClick }: { title: string; description: string;
    icon: ReactNode; label: string; disabled: boolean; className: string; onClick: () => void }) {
    return <SettingRow title={title} description={description}>
        <Button variant="outline" onClick={onClick} disabled={disabled} className={`h-9 shrink-0 gap-1.5 text-sm ${className}`}>
            {!disabled && icon}{label}</Button>
    </SettingRow>;
}

type Enrollment = { factorId: string; challengeId: string; qrCode: string; secret: string };

/** The authenticator app, its setup dialog, and whether each login asks for a code. */
function MfaSettings() {
    const { profile, updateMfaOnLogin } = useUserProfile();
    const { runMfa, mfaPopup } = useMfaAction();
    const [mfa, setMfa] = useState<{ factorId: string | null; sessionVerified: boolean } | null>(null);
    // Null while the setup dialog is closed.
    const [setup, setSetup] = useState<{ enrollment: Enrollment | null; code: string; copied: boolean } | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState<"login" | "action" | null>(null);
    const factorId = mfa?.factorId ?? null, enrollment = setup?.enrollment ?? null;
    const updateSetup = (patch: Partial<NonNullable<typeof setup>>) => setSetup((current) => current && { ...current, ...patch });
    const load = useCallback(() => Promise.all([listMfaFactors(), getMfaAssurance()]).then(
        ([factors, assurance]) => setMfa({ factorId: factors.totp?.[0]?.id ?? null, sessionVerified: assurance.currentLevel === "aal2" }),
        (caught: unknown) => {
            setStatus(errorMessage(caught, "Authenticator status could not be loaded."));
            setMfa({ factorId: null, sessionVerified: false });
        }), []);
    useEffect(() => { void load(); }, [load]);
    const refresh = () => { setStatus(null); return load(); };
    async function startEnrollment() {
        setBusy("action"); setStatus(null);
        try {
            const data = await enrollMfa("Beaver").catch((caught: unknown) => {
                if (!(caught instanceof Error) || !caught.message.toLowerCase().includes("friendly name")) throw caught;
                return enrollMfa(`Beaver ${Date.now()}`);
            });
            const challenge = await challengeMfa(data.id);
            updateSetup({ enrollment: { factorId: data.id, challengeId: challenge.id, qrCode: data.totp.qr_code, secret: data.totp.secret },
                code: "", copied: false });
        } catch (error) { setStatus(errorMessage(error, "Failed to start MFA setup.")); }
        finally { setBusy(null); }
    }
    async function cancelSetup(reopen: boolean) {
        if (busy) return;
        setSetup(reopen ? { enrollment: null, code: "", copied: false } : null);
        if (!enrollment) return;
        await unenrollMfa(enrollment.factorId).catch(() => null);
        await refresh();
    }
    async function verifyEnrollment() {
        if (!enrollment || setup?.code.trim().length !== 6) return;
        setBusy("action"); setStatus(null);
        try {
            await verifyMfa(enrollment.factorId, enrollment.challengeId, setup.code.trim());
            setSetup(null); setStatus("MFA enabled.");
            await refresh();
        } catch (error) { setStatus(errorMessage(error, "Failed to verify MFA code.")); }
        finally { setBusy(null); }
    }
    const loginMfaEnabled = profile?.mfaOnLogin === true;
    const toggleLogin = () => {
        if (!factorId || busy === "login") return;
        setStatus(null);
        void runMfa(async () => {
            setBusy("login");
            try { if (!(await updateMfaOnLogin(!loginMfaEnabled))) throw new Error("Failed to update login authentication preference."); }
            finally { setBusy(null); }
        }, { title: "Authenticator required", message: "Enter a code from your authenticator app to change login verification.",
            onError: (error) => setStatus(errorMessage(error, "Failed to update login authentication preference.")) });
    };
    const removeAuthenticator = () => {
        setStatus(null);
        void runMfa(async () => {
            setBusy("action");
            await unenrollMfa(factorId!);
            setBusy(null);
            if (profile?.mfaOnLogin) void updateMfaOnLogin(false);
            await refresh();
        }, { onError: (error) => setStatus(errorMessage(error, "Failed to remove authenticator.")) });
    };
    return <SettingsSection title="Multi-factor authentication">
        <AccountSection>
            {mfa === null ? <div className="h-36 p-4" aria-hidden><div className="h-full rounded-lg bg-gray-100" /></div> : <>
                <SettingRow title={<span className="flex items-center gap-3">Verification method
                    <span className={`text-xs font-medium ${factorId ? "text-green-700" : "text-gray-500"}`}>{factorId ? "Enabled" : "Not set up"}</span></span>}
                    description={factorId ? mfa.sessionVerified ? "Sensitive actions are unlocked for this session."
                        : "Sensitive actions require an authenticator code."
                        : "Protect sensitive actions such as deleting data and changing API keys."}>
                    {factorId ? <button type="button" onClick={removeAuthenticator} disabled={!!busy}
                        className="shrink-0 text-xs font-medium text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300">
                        Remove authenticator app</button>
                        : <Button variant="outline" onClick={() => setSetup({ enrollment: null, code: "", copied: false })} disabled={!!busy}
                            className={`h-9 shrink-0 ${accountGlassPrimaryButtonClassName}`}>Set up</Button>}
                </SettingRow>
                {factorId && <div className="border-t border-gray-200"><SettingRow title="Login verification" description="Require a code after each new login.">
                    <Switch checked={loginMfaEnabled} ariaLabel="Require login verification" disabled={busy === "login"}
                        loading={busy === "login"} size="md" onChange={toggleLogin} />
                </SettingRow></div>}
            </>}
            {status && <p className="border-t border-gray-200 px-4 py-3 text-xs text-gray-500">{status}</p>}
        </AccountSection>
        <Modal open={setup !== null} onClose={() => void cancelSetup(false)} breadcrumbs={["Settings", "Set up authenticator app"]}
            secondaryAction={enrollment ? { label: "Back", onClick: () => void cancelSetup(true), disabled: !!busy } : undefined}
            primaryAction={enrollment
                ? { label: busy ? "Verifying..." : "Verify", onClick: () => void verifyEnrollment(), disabled: !!busy || setup?.code.trim().length !== 6 }
                : { label: busy ? "Starting..." : "Continue", onClick: () => void startEnrollment(), disabled: !!busy }}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pt-2">
                <p className="text-sm font-medium text-gray-900">{enrollment ? "Scan this code" : "Open an authenticator app"}</p>
                <p className="text-sm text-gray-500">{enrollment
                    ? "In your authenticator app, add a new account and scan the QR code. If you cannot scan it, enter the setup key below manually."
                    : "Install one if needed, then choose the option to add an account."}</p>
                {enrollment && <>
                    <div className="min-w-0">
                        <div className="mb-1 flex items-center justify-between gap-3">
                            <p className="text-xs font-medium text-gray-500">Setup key</p>
                            <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-950"
                                onClick={() => void navigator.clipboard.writeText(enrollment.secret).then(() => {
                                    updateSetup({ copied: true });
                                    window.setTimeout(() => updateSetup({ copied: false }), 1600);
                                })}>
                                <Copy className="h-3 w-3" />{setup?.copied ? "Copied" : "Copy"}</button>
                        </div>
                        <p className="break-all font-mono text-xs text-gray-700">{enrollment.secret}</p>
                    </div>
                    <div className="mx-auto flex h-48 w-48 items-center justify-center rounded-xl bg-white p-2">
                        <img src={enrollment.qrCode} alt="MFA QR code" className="h-full w-full" />
                    </div>
                    <VerificationCodeInput value={setup?.code ?? ""} onChange={(code) => updateSetup({ code })} disabled={!!busy} />
                </>}
            </div>
        </Modal>
        {mfaPopup}
    </SettingsSection>;
}
