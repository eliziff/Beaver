import { Fragment, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    ModelToggle,
} from "@/app/components/assistant/ModelToggle";
import { AccountSection } from "../AccountSection";
type ModelPreferenceField = "titleModel" | "tabularModel";
/** The panel rows, so a new preference is one entry rather than a copied block. */
const MODEL_PREFERENCES: {
    field: ModelPreferenceField; label: string; info: string;
    fallback: string; includeSettingsModels?: boolean;
}[] = [
    { field: "titleModel", label: "Title generation model",
        info: "Names chats and other short titles.",
        fallback: "gemini-3.1-flash-lite-preview", includeSettingsModels: true },
    { field: "tabularModel", label: "Tabular review model",
        info: "Smaller models usually cost less for tabular reviews.",
        fallback: "gemini-3-flash-preview" },
];
export default function ModelPreferencesPage() {
    const { profile, updateProfile } = useUserProfile();
    const [savingField, setSavingField] = useState<ModelPreferenceField | null>(
        null,
    );
    const [optimisticValues, setOptimisticValues] = useState<
        Partial<Record<ModelPreferenceField, string>>
    >({});
    const handleModelChange = async (
        field: ModelPreferenceField,
        id: string,
    ) => {
        setOptimisticValues((current) => ({ ...current, [field]: id }));
        setSavingField(field);
        const ok = await updateProfile({ [field]: id });
        setSavingField((current) => (current === field ? null : current));
        if (!ok) {
            setOptimisticValues((current) => {
                const next = { ...current };
                delete next[field];
                return next;
            });
        }
    };
    return (
        <AccountSection heading="Model preferences">
                {MODEL_PREFERENCES.map(({ field, label, info, fallback, includeSettingsModels }, index) => {
                    const isSaving = savingField === field;
                    return <Fragment key={field}>
                        {index > 0 && <div className="mx-4 h-px bg-gray-200" />}
                        <div className="px-4 py-5">
                            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-gray-700">
                                {label}
                                <InfoButton text={info} />
                            </div>
                            <div className="flex w-full max-w-xs items-center gap-2">
                                <ModelToggle
                                    value={optimisticValues[field] ?? profile?.[field] ?? fallback}
                                    disabled={isSaving}
                                    includeSettingsModels={includeSettingsModels}
                                    apiKeys={profile?.apiKeys}
                                    onChange={(id) => handleModelChange(field, id)}
                                    className="max-w-xs"
                                />
                                <span className="h-3.5 w-3.5 shrink-0">
                                    {isSaving && (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-500" />
                                    )}
                                </span>
                            </div>
                        </div>
                    </Fragment>;
                })}
        </AccountSection>
    );
}
function InfoButton({ text }: { text: string }) {
    return (
        <span
            title={text}
            aria-label={text}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-400 hover:text-gray-700 focus-visible:text-gray-700"
        >
            <Info className="h-3.5 w-3.5" />
        </span>
    );
}
