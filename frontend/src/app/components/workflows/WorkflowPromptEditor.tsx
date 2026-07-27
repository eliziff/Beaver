"use client";

interface Props {
    value: string;
    onChange?: (markdown: string) => void;
    readOnly?: boolean;
}

export function WorkflowPromptEditor({
    value,
    onChange,
    readOnly = false,
}: Props) {
    return (
        <textarea
            aria-label="Workflow prompt"
            value={value}
            readOnly={readOnly}
            onChange={(event) => onChange?.(event.target.value)}
            placeholder="Write the workflow prompt in Markdown."
            spellCheck
            className="min-h-80 w-full resize-y rounded-md border border-gray-300 bg-white p-4 font-mono text-sm leading-6 text-gray-900 outline-none focus:border-gray-600 read-only:resize-none read-only:bg-gray-50"
        />
    );
}
