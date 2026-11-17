import type { HarborAfaPnpEntitlement, HarborAfaPnpSupport } from "@harbor/attempt-protocol";

export type ProfileSupportMode = "off" | "offer" | "open" | "block";
type ProfileMediaSupport = Extract<
  HarborAfaPnpSupport,
  "transcript" | "caption" | "audio-description" | "sign-language"
>;

export function OverrideInput(props: {
  label: string;
  value: string;
  onInput: (value: string) => void;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        value={props.value}
        inputMode="numeric"
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

export function ProfileCheckbox(props: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label class="toggle">
      <input
        checked={props.checked}
        type="checkbox"
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function ProfileSupportModeControl(props: {
  label: string;
  name: string;
  value: ProfileSupportMode;
  onChange: (value: ProfileSupportMode) => void;
}) {
  const options: Array<{ value: ProfileSupportMode; label: string }> = [
    { value: "off", label: "Off" },
    { value: "offer", label: "Offer" },
    { value: "open", label: "Open" },
    { value: "block", label: "Block" },
  ];

  return (
    <fieldset class="profile-support-mode">
      <legend>{props.label}</legend>
      <div class="profile-radio-row">
        {options.map((option) => (
          <label key={option.value}>
            <input
              checked={props.value === option.value}
              name={props.name}
              type="radio"
              value={option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function buildProfilePnpEntitlement(
  input: Record<ProfileMediaSupport, ProfileSupportMode> & {
    languages: string;
  },
): HarborAfaPnpEntitlement | undefined {
  const activateAsOptionSet: HarborAfaPnpSupport[] = [];
  const activateAtInitializationSet: HarborAfaPnpSupport[] = [];
  const prohibitSet: HarborAfaPnpSupport[] = [];
  const entries: Array<[ProfileMediaSupport, ProfileSupportMode]> = [
    ["transcript", input.transcript],
    ["caption", input.caption],
    ["audio-description", input["audio-description"]],
    ["sign-language", input["sign-language"]],
  ];

  for (const [support, mode] of entries) {
    if (mode === "offer") {
      activateAsOptionSet.push(support);
    } else if (mode === "open") {
      activateAtInitializationSet.push(support);
    } else if (mode === "block") {
      prohibitSet.push(support);
    }
  }

  const languages = input.languages
    .split(",")
    .map((language) => language.trim())
    .filter((language, index, all) => language.length > 0 && all.indexOf(language) === index);
  const entitlement: HarborAfaPnpEntitlement = {
    ...(activateAsOptionSet.length > 0 ? { activateAsOptionSet } : {}),
    ...(activateAtInitializationSet.length > 0 ? { activateAtInitializationSet } : {}),
    ...(prohibitSet.length > 0 ? { prohibitSet } : {}),
    ...(languages.length > 0 ? { languages } : {}),
  };

  return Object.keys(entitlement).length > 0 ? entitlement : undefined;
}

export function isLegacyShellMode(mode: ProfileSupportMode): boolean {
  return mode === "offer" || mode === "open";
}

export function normalizeOptionalInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildActionId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}`;
}

export function formatScore(total: number | null, max: number | null): string {
  if (total === null && max === null) return "Not scored";
  if (max !== null && max <= 0 && (total === null || total === 0)) return "Submitted";
  return `${total ?? "?"} / ${max ?? "?"}`;
}

export function formatTimestamp(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not yet";
}

export function formatPercent(value: number | null): string {
  return value === null ? "Not available" : `${value}%`;
}

export function formatResultStatus(value: string | null): string {
  if (value === "pending") return "Scoring in progress";
  if (value === "failed") return "Score unavailable";
  if (value === "complete" || value === "rescored") {
    return value === "rescored" ? "Rescored" : "Score ready";
  }
  return "Submitted";
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "None";
  const minutes = Math.round(seconds / 60);
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
