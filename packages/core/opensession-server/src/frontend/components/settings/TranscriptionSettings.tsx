import { useEffect, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  SettingCard,
  SettingGroup,
  SettingsGroupLabel,
  SettingsHint,
  SettingRow,
  SettingRowControl,
  SettingRowDescription,
  SettingRowText,
  SettingRowTitle,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import {
  setupRequest,
  type SetupTranscription,
  type SetupTranscriptionProvider,
} from "../setup-shared";
import { Select } from "./shared";

const DEFAULT_SETTINGS: SetupTranscription = {
  provider: "auto",
  geminiApiKeyConfigured: false,
};

const PROVIDER_OPTIONS: Array<{
  value: SetupTranscriptionProvider;
  label: string;
}> = [
  { value: "auto", label: "Automatic" },
  { value: "gemini", label: "Gemini 3.5 Transcribe" },
  { value: "openai", label: "OpenAI" },
  { value: "groq", label: "Groq" },
  { value: "local", label: "Local whisper.cpp" },
];

export function TranscriptionSettings({
  settings,
}: {
  settings?: SetupTranscription;
}) {
  const [current, setCurrent] = useState(settings ?? DEFAULT_SETTINGS);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setCurrent(settings);
  }, [settings]);

  async function update(input: {
    provider?: SetupTranscriptionProvider;
    geminiApiKey?: string;
  }): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const body = await setupRequest<{
        transcription: SetupTranscription;
      }>("/api/setup/transcription", {
        method: "PUT",
        json: input,
      });
      setCurrent(body.transcription);
      setSaving(false);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save transcription settings",
      );
      setSaving(false);
      return false;
    }
  }

  async function selectProvider(provider: SetupTranscriptionProvider) {
    const previous = current.provider;
    setCurrent((value) => ({ ...value, provider }));
    if (await update({ provider })) {
      toast("Transcription provider saved");
    } else {
      setCurrent((value) => ({ ...value, provider: previous }));
    }
  }

  async function saveGeminiKey() {
    const key = apiKey.trim();
    if (!key) return;
    if (await update({ provider: "gemini", geminiApiKey: key })) {
      setApiKey("");
      toast("Gemini API key saved");
    }
  }

  async function removeGeminiKey() {
    if (await update({ geminiApiKey: "" })) {
      setApiKey("");
      toast("Gemini API key removed");
    }
  }

  return (
    <>
      <SettingsGroupLabel>Voice transcription</SettingsGroupLabel>
      <SettingCard>
        <SettingRow>
          <SettingRowText>
            <SettingRowTitle>Provider</SettingRowTitle>
            <SettingRowDescription>
              Automatic tries OpenAI, Groq, Gemini, then local transcription.
            </SettingRowDescription>
          </SettingRowText>
          <SettingRowControl>
            <Select
              label="Voice transcription provider"
              value={current.provider}
              options={PROVIDER_OPTIONS}
              disabled={saving}
              onChange={(provider) => void selectProvider(provider)}
            />
          </SettingRowControl>
        </SettingRow>
        <SettingGroup>
          {current.geminiApiKeyConfigured && (
            <SettingRow>
              <SettingRowText>
                <SettingRowTitle>Gemini API key</SettingRowTitle>
                <SettingRowDescription>
                  Stored on this server, {current.geminiApiKeyMasked ?? ""}.
                </SettingRowDescription>
              </SettingRowText>
              <SettingRowControl>
                <Button
                  size="sm"
                  className="phone:min-h-11"
                  disabled={saving}
                  onClick={() => void removeGeminiKey()}
                >
                  Remove
                </Button>
              </SettingRowControl>
            </SettingRow>
          )}
          <SettingRow>
            <SettingRowText>
              <SettingRowTitle>
                {current.geminiApiKeyConfigured
                  ? "Replace key"
                  : "Gemini API key"}
              </SettingRowTitle>
              <SettingRowDescription>
                Used for microphone dictation. Saving a key selects Gemini.
              </SettingRowDescription>
            </SettingRowText>
            <SettingRowControl className="w-80 max-w-full phone:ml-0 phone:w-full">
              <div className="flex items-center gap-2 phone:flex-col">
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label="Gemini API key"
                  className="min-w-0 flex-1 phone:min-h-11 phone:w-full"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Paste Gemini API key"
                  disabled={saving}
                />
                <Button
                  size="sm"
                  variant="primary"
                  className="phone:min-h-11 phone:w-full"
                  disabled={saving || !apiKey.trim()}
                  onClick={() => void saveGeminiKey()}
                >
                  {saving ? "Saving…" : "Save and use"}
                </Button>
              </div>
            </SettingRowControl>
          </SettingRow>
        </SettingGroup>
        {error && (
          <div className="px-5 pb-4">
            <InlineAlert>{error}</InlineAlert>
          </div>
        )}
      </SettingCard>
      <SettingsHint>
        Gemini uses Smart transcription. Open Session requests deletion of each
        uploaded clip after transcription. Changes apply immediately.
      </SettingsHint>
    </>
  );
}
