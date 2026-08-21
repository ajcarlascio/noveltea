import { useState } from "react";
import { useSettings } from "@/app/settings/SettingsContext";
import { grantConsent, revokeConsent, type NetworkFeature } from "@/app/settings/settings";
import { ConsentDialog } from "./ConsentDialog";

/**
 * A switch for something that sends words off the device.
 *
 * Turning it **on** always opens the consent dialog first, even if consent was
 * granted and withdrawn before — withdrawing means the answer was no, and asking
 * again is the point. Turning it **off** is immediate and needs no ceremony.
 */
export function NetworkFeatureToggle({
  feature,
  label,
  description,
  whatIsSent,
  recipient,
  notes,
  confirmLabel,
  children,
}: {
  feature: NetworkFeature;
  label: string;
  description: string;
  whatIsSent: string;
  recipient: string;
  notes?: string[];
  confirmLabel: string;
  /** Extra controls, shown only once the feature is on. */
  children?: React.ReactNode;
}) {
  const { update, mayUse } = useSettings();
  const [asking, setAsking] = useState(false);
  const enabled = mayUse(feature);

  return (
    <div className="network-feature">
      <label className="network-feature__row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            if (event.target.checked) setAsking(true);
            else update((current) => revokeConsent(current, feature));
          }}
        />
        <span>
          <span className="network-feature__label">{label}</span>
          <span className="network-feature__description">{description}</span>
        </span>
      </label>

      {enabled && children !== undefined && (
        <div className="network-feature__extra">{children}</div>
      )}

      <ConsentDialog
        open={asking}
        title={label}
        whatIsSent={whatIsSent}
        recipient={recipient}
        {...(notes ? { notes } : {})}
        confirmLabel={confirmLabel}
        onConfirm={() => {
          setAsking(false);
          update((current) => grantConsent(current, feature));
        }}
        onCancel={() => setAsking(false)}
      />
    </div>
  );
}
