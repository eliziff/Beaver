import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { SiteLogo } from "@/app/components/site-logo";
import { JurisdictionPreferenceEditor } from "@/app/components/settings/JurisdictionPreferenceEditor";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { AccountSection } from "@/app/(pages)/account/AccountSection";
import { CollectionState } from "@/app/components/shared/CollectionState";

function Fields({ onboarding, onDone }: {
    onboarding: boolean;
    onDone?: () => void;
}) {
    const { profile, loading, updateProfile } = useUserProfile();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError(null);
        const saved = await updateProfile({
            displayName: String(form.get("displayName") ?? "").trim() || null,
            organisation: String(form.get("organisation") ?? "").trim() || null,
            professionalTitle: String(form.get("professionalTitle") ?? "").trim() || null,
            practiceSetting: String(form.get("practiceSetting") ?? "").trim() || null,
            practiceAreas: String(form.get("practiceAreas") ?? "").split(",")
                .map((value) => value.trim()).filter(Boolean).slice(0, 12),
            ...(!onboarding && { filingContact: {
                name: String(form.get("filingName") ?? "").trim(),
                address: String(form.get("filingAddress") ?? "").trim(),
                phone: String(form.get("filingPhone") ?? "").trim(),
                fax: String(form.get("filingFax") ?? "").trim(),
                email: String(form.get("filingEmail") ?? "").trim(),
            } }),
            ...(onboarding ? { onboardingCompleted: true } : {}),
        });
        setBusy(false);
        if (!saved) {
            setError("Your preferences could not be saved.");
            return;
        }
        onDone?.();
    }

    if (loading || !profile) return <CollectionState loading className="min-h-0 justify-start px-0 py-8">Loading…</CollectionState>;
    return (
        <form key={`${profile.displayName}:${profile.organisation}`} onSubmit={save} className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
                <label htmlFor="personal-display-name" className="text-sm font-medium text-gray-700">
                    Name
                    <Input id="personal-display-name" name="displayName" autoComplete="name"
                        defaultValue={profile.displayName ?? ""} className="mt-2" />
                </label>
                <label htmlFor="personal-organisation" className="text-sm font-medium text-gray-700">
                    Organisation
                    <Input id="personal-organisation" name="organisation" autoComplete="organization"
                        defaultValue={profile.organisation ?? ""} className="mt-2" />
                </label>
                <label htmlFor="personal-title" className="text-sm font-medium text-gray-700">
                    Professional title
                    <Input id="personal-title" name="professionalTitle"
                        defaultValue={profile.professionalTitle ?? ""} placeholder="e.g. Associate" className="mt-2" />
                </label>
                <label htmlFor="personal-setting" className="text-sm font-medium text-gray-700">
                    Practice setting
                    <select id="personal-setting" name="practiceSetting"
                        defaultValue={profile.practiceSetting ?? ""}
                        className="mt-2 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                        <option value="">Not specified</option>
                        <option value="private_practice">Private practice</option>
                        <option value="in_house">In-house</option>
                        <option value="government">Government</option>
                        <option value="academic">Academic</option>
                        <option value="not_practising">Not practising</option>
                        <option value="other">Other</option>
                    </select>
                </label>
            </div>
            <label htmlFor="personal-practice-areas" className="block text-sm font-medium text-gray-700">
                Practice areas
                <Input id="personal-practice-areas" name="practiceAreas"
                    defaultValue={profile.practiceAreas.join(", ")}
                    placeholder="e.g. commercial litigation, employment" className="mt-2" />
                <span className="mt-1 block text-xs font-normal text-gray-500">Separate areas with commas.</span>
            </label>
            <div>
                <h2 className="mb-2 text-sm font-medium text-gray-900">Default jurisdiction</h2>
                <JurisdictionPreferenceEditor compact />
            </div>
            {!onboarding && <fieldset className="border-t border-gray-200 pt-5">
                <legend className="text-sm font-semibold text-gray-950">Court filing details</legend>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-medium text-gray-700">Name on court documents
                        <Input name="filingName" autoComplete="name"
                            defaultValue={profile.filingContact.name || profile.displayName || ""} className="mt-2" />
                    </label>
                    <label className="text-sm font-medium text-gray-700">Email
                        <Input name="filingEmail" type="email" autoComplete="email"
                            defaultValue={profile.filingContact.email} className="mt-2" />
                    </label>
                    <label className="text-sm font-medium text-gray-700 sm:col-span-2">Address for service
                        <textarea name="filingAddress" rows={2} autoComplete="street-address"
                            defaultValue={profile.filingContact.address}
                            className="mt-2 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-base leading-6 outline-none focus-visible:ring-2 focus-visible:ring-red-600" />
                    </label>
                    <label className="text-sm font-medium text-gray-700">Telephone
                        <Input name="filingPhone" type="tel" autoComplete="tel"
                            defaultValue={profile.filingContact.phone} className="mt-2" />
                    </label>
                    <label className="text-sm font-medium text-gray-700">Fax
                        <Input name="filingFax" type="tel"
                            defaultValue={profile.filingContact.fax} className="mt-2" />
                    </label>
                </div>
            </fieldset>}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <div className="flex flex-wrap justify-end gap-3">
                {onboarding && (
                    <Button type="button" variant="ghost" disabled={busy} onClick={async () => {
                        setBusy(true);
                        if (await updateProfile({ onboardingCompleted: true })) onDone?.();
                        else setError("Onboarding could not be skipped.");
                        setBusy(false);
                    }}>
                        Skip for now
                    </Button>
                )}
                <Button type="submit" disabled={busy}>
                    {busy ? "Saving…" : onboarding ? "Continue" : "Save changes"}
                </Button>
            </div>
        </form>
    );
}

export function OnboardingPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const state = location.state as { next?: string } | null;
    const requested = state?.next ?? new URLSearchParams(location.search).get("next") ?? "";
    const next = requested.startsWith("/") && !requested.startsWith("//") &&
        !requested.includes("\\") ? requested : "/assistant";
    return (
        <main className="min-h-dvh bg-gray-50 px-5 py-8 sm:py-12">
            <div className="mx-auto mb-8 w-fit"><SiteLogo size="lg" asLink /></div>
            <section className="mx-auto w-full max-w-2xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8">
                <h1 className="font-serif text-3xl font-medium text-gray-950">Make Beaver yours</h1>
                <p className="mt-2 text-sm leading-6 text-gray-600">
                    A few optional details help Beaver choose useful defaults. You can change them later.
                </p>
                <div className="mt-8"><Fields onboarding onDone={() => navigate(next, { replace: true })} /></div>
            </section>
        </main>
    );
}

export function PersonalisationSettingsPage() {
    return (
        <AccountSection heading="Personalisation">
            <div className="p-4 sm:p-5"><Fields onboarding={false} /></div>
        </AccountSection>
    );
}
