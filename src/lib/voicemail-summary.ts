export function summaryConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    url: (env.VOICEMAIL_SUMMARY_URL?.trim() || "http://192.168.1.71:20128/v1").replace(/\/+$/, ""),
    model: env.VOICEMAIL_SUMMARY_MODEL?.trim() || "",
    apiKey: env.OMNIROUTE_API_KEY?.trim() || "",
  };
}

export async function generateVoicemailSummary(
  transcript: string,
  config = summaryConfig(),
  request: typeof fetch = fetch,
): Promise<string> {
  if (!config.model || !config.apiKey || config.apiKey.startsWith("vault://")) {
    throw new Error("Configure VOICEMAIL_SUMMARY_MODEL and resolve OMNIROUTE_API_KEY from Cerulean Vault.");
  }
  const prompt =
    "You are a voicemail assistant. Summarise the following voicemail transcription " +
    "in 1-3 concise sentences: who called, why, and any requested call-back " +
    "number or action. Plain text only, no preamble.\n\nTranscript:\n" +
    transcript.slice(0, 4000);
  const response = await request(`${config.url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Summary gateway returned HTTP ${response.status}.`);
  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  const summary = typeof content === "string" ? content.trim() : "";
  if (!summary) throw new Error("Summary gateway returned an empty summary.");
  return summary;
}
