import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SettingsProvider } from "@/app/settings/SettingsProvider";
import { useSettings } from "@/app/settings/SettingsContext";
import { DEFAULT_SETTINGS, grantConsent, type Settings } from "@/app/settings/settings";
import { NetworkFeatureToggle } from "../NetworkFeatureToggle";

/** Reports the stored state so assertions read the model, not the checkbox. */
function Probe() {
  const { settings } = useSettings();
  return (
    <output data-testid="state">
      {settings.datamuse.enabled ? "on" : "off"}/
      {settings.consent.datamuse.grantedAt === null ? "unconsented" : "consented"}
    </output>
  );
}

function renderToggle(initial: Settings = DEFAULT_SETTINGS) {
  return render(
    <SettingsProvider initial={initial}>
      <NetworkFeatureToggle
        feature="datamuse"
        label="Datamuse word finder"
        description="Rhymes and related words."
        whatIsSent="The single word you look up."
        recipient="datamuse.com, a third-party service."
        notes={["Only when you ask for a lookup."]}
        confirmLabel="Send lookups to Datamuse"
      />
      <Probe />
    </SettingsProvider>,
  );
}

const state = () => screen.getByTestId("state").textContent;

describe("turning it on", () => {
  it("asks before anything is enabled", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("checkbox"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Ticking the box is a request to be asked, not consent itself.
    expect(state()).toBe("off/unconsented");
  });

  it("says what is sent and where it goes", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("checkbox"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("The single word you look up.");
    expect(dialog).toHaveTextContent("datamuse.com");
    expect(dialog).toHaveTextContent("Only when you ask for a lookup.");
    // The claim that makes the rest meaningful.
    expect(dialog).toHaveTextContent(/sends your words off this device/i);
  });

  it("enables and records consent only on the explicit confirmation", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Send lookups to Datamuse" }));

    expect(state()).toBe("on/consented");
  });
});

describe("declining", () => {
  it("leaves it off when dismissed", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Keep it off" }));

    expect(state()).toBe("off/unconsented");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("focuses the declining button, so a reflex press leaves it off", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("checkbox"));
    // Someone dismissing a dialog without reading it should land on the reversible
    // outcome, not on having agreed to send their words somewhere.
    expect(screen.getByRole("button", { name: "Keep it off" })).toHaveFocus();
  });

  it("leaves it off when Escape closes the dialog", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.keyboard("{Escape}");

    expect(state()).toBe("off/unconsented");
  });
});

describe("turning it off", () => {
  it("takes effect at once, with no dialog", async () => {
    renderToggle(grantConsent(DEFAULT_SETTINGS, "datamuse"));
    expect(state()).toBe("on/consented");

    await userEvent.click(screen.getByRole("checkbox"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Consent is forgotten too, not just the switch.
    expect(state()).toBe("off/unconsented");
  });

  it("asks again the next time it is turned on", async () => {
    renderToggle(grantConsent(DEFAULT_SETTINGS, "datamuse"));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("checkbox"));

    // Remembering the earlier yes would re-enable it silently, which is not what
    // someone who turned it off meant.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(state()).toBe("off/unconsented");
  });
});
