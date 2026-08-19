import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, Trash2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { useMfaAction } from "@/app/components/account/useMfaAction";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { deleteAccount } from "@/app/lib/beaverApi";
import {
    accountGlassDangerOutlineButtonClassName,
    accountGlassInputClassName,
} from "./accountStyles";
import { AccountSection } from "./AccountSection";
export default function AccountPage() {
    const navigate = useNavigate();
    const { user, signOut, updateEmail } = useAuth();
    const { profile, updateProfile } = useUserProfile();
    const [savingProfile, setSavingProfile] = useState(false);
    const [isSavingEmail, setIsSavingEmail] = useState(false);
    const [emailStatus, setEmailStatus] = useState<string | null>(null);
    const [emailWarning, setEmailWarning] = useState<string | null>(null);
    const [actionWarning, setActionWarning] = useState<string | null>(null);
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const { runMfa, mfaPopup } = useMfaAction();
    const handleLogout = async () => {
        await signOut();
        navigate("/");
    };
    const handleDeleteAccount = () => {
        void runMfa(
            async () => {
                setIsDeleting(true);
                try {
                    await deleteAccount();
                    await signOut();
                    navigate("/");
                } finally {
                    setIsDeleting(false);
                }
            },
            {
                title: "Two-factor verification required",
                message:
                    "Account deletion is sensitive. Enter a code from your authenticator app to continue.",
                onPending: () => setDeleteConfirm(false),
                onError: () => {
                    setDeleteConfirm(false);
                    setActionWarning("Failed to delete account. Please try again.");
                },
            },
        );
    };
    const handleSaveEmail = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem(
            "email",
        ) as HTMLInputElement;
        const nextEmail = input.value.trim();
        if (!nextEmail || nextEmail === user?.email) return;
        setEmailStatus(null);
        setEmailWarning(null);
        void runMfa(
            async () => {
                setIsSavingEmail(true);
                try {
                    const updatedUser = await updateEmail(nextEmail);
                    const pendingEmail = updatedUser.pendingEmail;
                    setEmailStatus(
                        pendingEmail
                            ? `Confirmation sent to ${pendingEmail}. Your current email remains ${updatedUser.email} until the change is confirmed.`
                            : "Email updated.",
                    );
                } finally {
                    setIsSavingEmail(false);
                }
            },
            {
                title: "Two-factor verification required",
                message:
                    "Email changes are sensitive. Enter a code from your authenticator app to continue.",
                onError: (error) => {
                    const message =
                        error instanceof Error
                            ? error.message
                            : "Failed to update email. Please try again.";
                    if (isAlreadyRegisteredEmailError(message)) {
                        input.value =
                            user?.pendingEmail || user?.email || "";
                        setEmailWarning(message);
                    } else {
                        setEmailStatus(message);
                    }
                },
            },
        );
    };
    const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setSavingProfile(true);
        const success = await updateProfile({
            displayName: String(form.get("displayName") ?? "").trim(),
            organisation: String(form.get("organisation") ?? "").trim(),
        });
        setSavingProfile(false);
        if (!success) setActionWarning("Failed to update profile. Please try again.");
    };
    if (!user) return null;
    return (
        <div className="space-y-8">
            <AccountSection heading="Profile" className="p-4">
                    <form
                        key={`${profile?.displayName}:${profile?.organisation}`}
                        onSubmit={(event) => void saveProfile(event)}
                    >
                        <div className="divide-y divide-gray-200">
                            {(
                                [
                                    ["displayName", "Display name", "Enter your name"],
                                    ["organisation", "Organisation", "Enter your organisation"],
                                ] as const
                            ).map(([field, label, placeholder], index) => (
                                <div
                                    key={field}
                                    className={index ? "pt-4" : "pb-4"}
                                >
                                    <label
                                        htmlFor={`profile-${field}`}
                                        className="mb-2 block text-sm text-gray-600"
                                    >
                                        {label}
                                    </label>
                                    <Input
                                        id={`profile-${field}`}
                                        name={field}
                                        defaultValue={profile?.[field] ?? ""}
                                        placeholder={placeholder}
                                        className={accountGlassInputClassName}
                                    />
                                </div>
                            ))}
                        </div>
                        <div className="flex justify-end pt-4">
                            <button
                                type="submit"
                                disabled={savingProfile}
                                className="text-xs font-medium text-gray-700 hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                            >
                                {savingProfile ? "Saving..." : "Save"}
                            </button>
                        </div>
                    </form>
            </AccountSection>
            <AccountSection heading="Email" className="p-4">
                    <form
                        key={user.pendingEmail || user.email}
                        className="space-y-2"
                        onSubmit={handleSaveEmail}
                    >
                        <Input
                            name="email"
                            type="email"
                            defaultValue={user.pendingEmail || user.email}
                            onChange={() => {
                                setEmailStatus(null);
                                setEmailWarning(null);
                            }}
                            placeholder="Enter your email"
                            className={accountGlassInputClassName}
                        />
                        {emailStatus ? (
                            <p className="text-xs text-gray-500">
                                {emailStatus}
                            </p>
                        ) : user.pendingEmail ? (
                            <p className="text-xs text-gray-500">
                                Pending confirmation: {user.pendingEmail}
                            </p>
                        ) : null}
                        <div className="flex justify-end">
                            <button
                                type="submit"
                                disabled={isSavingEmail}
                                className="text-xs font-medium text-gray-700 hover:text-gray-950 disabled:cursor-not-allowed disabled:text-gray-400"
                            >
                                {isSavingEmail ? "Saving..." : "Save"}
                            </button>
                        </div>
                    </form>
            </AccountSection>
            <AccountSection heading="Usage Plan" className="p-4">
                <p className="text-base font-medium text-gray-500 capitalize">
                    {profile?.tier || "Free"}
                </p>
            </AccountSection>
            <Button
                variant="outline"
                onClick={handleLogout}
                className="w-full gap-1.5 rounded-lg border border-transparent bg-gray-950 px-3 text-white shadow-none hover:bg-gray-900 hover:text-white active:bg-black sm:w-auto"
            >
                <LogOut className="h-4 w-4 shrink-0" />
                Sign out
            </Button>
            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-red-600">
                    Delete account
                </h2>
                <AccountSection className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-gray-500">
                        Permanently deletes your account and its data.
                    </p>
                    <Button
                        variant="outline"
                        onClick={() => setDeleteConfirm(true)}
                        disabled={isDeleting}
                        className={`w-full shrink-0 gap-1.5 sm:w-auto ${accountGlassDangerOutlineButtonClassName}`}
                    >
                        <Trash2 className="h-4 w-4 shrink-0" />
                        Delete account
                    </Button>
                </AccountSection>
            </section>
            <ConfirmPopup
                open={deleteConfirm}
                title="Delete account?"
                message="This will permanently delete your account and all associated data. This action cannot be undone."
                confirmLabel="Delete"
                confirmStatus={isDeleting ? "loading" : "idle"}
                cancelLabel="Cancel"
                onCancel={() => {
                    if (isDeleting) return;
                    setDeleteConfirm(false);
                }}
                onConfirm={handleDeleteAccount}
            />
            <WarningPopup
                open={!!emailWarning}
                title="Email already registered"
                message={emailWarning}
                onClose={() => setEmailWarning(null)}
            />
            <WarningPopup
                open={!!actionWarning}
                message={actionWarning}
                onClose={() => setActionWarning(null)}
            />
            {mfaPopup}
        </div>
    );
}
function isAlreadyRegisteredEmailError(message: string) {
    return message
        .toLowerCase()
        .includes("a user with this email address has already been registered");
}
