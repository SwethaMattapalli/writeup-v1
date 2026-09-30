declare global {
  interface Window {
    electronAPI: {
      onStateChange(
        cb: (p: {
          type: string;
          text?: string;
          truncated?: boolean;
          reason?: "empty" | "permission";
          hotkey?: string;
        }) => void
      ): () => void;
      widgetUiReady(): Promise<boolean>;
      minimizeWidget(): Promise<void>;
      resizeWidget(size: { width: number; height: number }): Promise<void>;
      getLastTone(): Promise<string>;
      setLastTone(tone: string): Promise<void>;
      dismissWidget(): Promise<void>;
      pasteBack(text: string): Promise<void>;
      getSetupState(): Promise<{
        stage: string;
        message: string;
        detail?: string;
        ready?: boolean;
      }>;
      getBackendConfig(): Promise<{ url: string; accessKey: string }>;
      saveAccessKey(key: string): Promise<boolean>;
      saveApiKey(key: string): Promise<boolean>;
      saveLlmSettings(cfg: {
        provider: "ollama" | "openrouter";
        ollamaUrl?: string;
        ollamaModel?: string;
        apiKey?: string;
      }): Promise<boolean>;
      retrySetup(): Promise<unknown>;
      finishSetup(): Promise<void>;
      onSetupProgress(
        cb: (p: { stage: string; message: string; detail?: string }) => void
      ): () => void;
    };
  }
}

export {};
