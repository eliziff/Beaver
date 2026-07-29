import { PRACTICE_OPTIONS } from "../workflows/practices";
import { ModalSelect } from "../modals/ModalSelect";
import { ModalTextInput } from "../modals/ModalTextInput";
const OPTION_NONE = "__none__";
const OPTION_OTHER = "Other";
const OPTIONS = [{ value: OPTION_NONE, label: "None" }, ...PRACTICE_OPTIONS];
interface ProjectPracticeFieldProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}
export function ProjectPracticeField({
    id,
    value,
    onChange,
    disabled = false,
}: ProjectPracticeFieldProps) {
    const selectedOption = !value.trim()        ? OPTION_NONE        : (PRACTICE_OPTIONS as readonly string[]).includes(value)          ? value          : OPTION_OTHER;    const customValue =
        selectedOption === OPTION_OTHER && value !== OPTION_OTHER ? value : "";
    return (
        <div className="space-y-2">
            <ModalSelect
                id={id}
                value={selectedOption}
                options={OPTIONS}
                onChange={(option) =>
                    onChange(option === OPTION_NONE ? "" : option)
                }
                placeholder="Select practice"
                disabled={disabled}
            />
            {selectedOption === OPTION_OTHER && (
                <ModalTextInput
                    type="text"
                    value={customValue}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder="Enter practice..."
                    disabled={disabled}
                />
            )}
        </div>
    );
}
