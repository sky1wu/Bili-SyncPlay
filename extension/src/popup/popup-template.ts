import { DEFAULT_SERVER_URL } from "../background/runtime-state";
import { escapeHtml } from "./helpers";
import { t } from "../shared/i18n";

export function renderPopupTemplate(): string {
  return `
    <div class="popup-shell">
      <header class="popup-header">
        <h1 class="popup-title">${escapeHtml(t("popupTitle"))}</h1>
        <div class="connection-indicator">
          <span class="connection-status" id="server-status">-</span>
        </div>
      </header>

      <section class="popup-section">
        <div class="section-heading section-heading-room">
          <span class="room-heading-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" focusable="false">
              <path d="M3.5 13.5V3.5H12.5V13.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
              <path d="M6.2 13.5V5.8H10.4V13.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path>
              <circle cx="9.1" cy="9.5" r="0.45" fill="currentColor"></circle>
            </svg>
          </span>
          <span>${escapeHtml(t("sectionRoom"))}</span>
        </div>

        <div class="room-panel room-panel-joined" id="room-panel-joined">
          <div class="room-joined-header">
            <div class="room-code-block">
              <div class="field-label">${escapeHtml(t("metricCurrentRoomCode"))}</div>
              <div class="room-code-value" id="room-status">-</div>
            </div>
            <div class="room-actions">
              <button class="secondary compact-button copy-button" id="copy-room" type="button">
                <span class="button-icon-wrap" aria-hidden="true">
                  <svg class="button-icon button-icon-copy" viewBox="0 0 16 16">
                    <rect x="5" y="3" width="8" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"></rect>
                    <path d="M3.5 10.5V5.5C3.5 4.4 4.4 3.5 5.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
                  </svg>
                  <svg class="button-icon button-icon-check" viewBox="0 0 16 16">
                    <path d="M3.2 8.3L6.6 11.4L12.8 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                  </svg>
                </span>
                <span class="button-label">${escapeHtml(t("actionCopy"))}</span>
              </button>
              <button class="secondary compact-button danger-button" id="leave-room" type="button">${escapeHtml(t("actionLeave"))}</button>
            </div>
          </div>
        </div>

        <div class="room-panel room-panel-idle" id="room-panel-idle">
          <div class="room-entry-row">
            <button class="compact-button primary-button" id="create-room" type="button">${escapeHtml(t("actionCreate"))}</button>
            <input id="room-code" placeholder="${escapeHtml(t("roomCodePlaceholder"))}">
            <button class="secondary compact-button" id="join-room" type="button">${escapeHtml(t("actionJoin"))}</button>
          </div>
        </div>

        <div class="status-banner" id="status-message" hidden></div>
      </section>

      <section class="popup-section">
        <div class="section-heading">${escapeHtml(t("sectionSharedVideo"))}</div>

        <button class="video-card video-card-button" id="shared-video-card" type="button">
          <div class="video-title" id="shared-video-title">${escapeHtml(t("stateNoSharedVideo"))}</div>
          <div class="video-subline">
            <div class="video-meta" id="shared-video-meta">${escapeHtml(t("actionOpenSharedVideoHint"))}</div>
            <div class="video-owner" id="shared-video-owner" hidden>${escapeHtml(t("ownerSharedBy", { owner: "-" }))}</div>
          </div>
        </button>

        <button class="secondary compact-button full-width-button share-button" id="share-current-video" type="button">${escapeHtml(t("actionShareCurrentVideo"))}</button>
      </section>

      <section class="popup-section">
        <div class="section-heading section-heading-inline">
          <span>${escapeHtml(t("sectionVoiceChat"))}</span>
          <span class="section-meta" id="voice-status">-</span>
        </div>

        <div class="voice-panel">
          <div class="voice-state-line">
            <span class="voice-dot" id="voice-dot" aria-hidden="true"></span>
            <span id="voice-mic-state">${escapeHtml(t("voiceMicMuted"))}</span>
          </div>
          <button class="secondary compact-button voice-mic-button" id="voice-mic-toggle" type="button" aria-pressed="false">
            <span class="button-icon-wrap" aria-hidden="true">
              <svg class="button-icon" viewBox="0 0 16 16">
                <path d="M8 2.5A2.2 2.2 0 0 0 5.8 4.7V8A2.2 2.2 0 0 0 10.2 8V4.7A2.2 2.2 0 0 0 8 2.5Z" fill="none" stroke="currentColor" stroke-width="1.5"></path>
                <path d="M4.2 7.7V8A3.8 3.8 0 0 0 8 11.8M11.8 7.7V8A3.8 3.8 0 0 1 8 11.8M8 11.8V14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
              </svg>
            </span>
            <span class="button-label" id="voice-mic-label">${escapeHtml(t("voiceActionUnmute"))}</span>
          </button>
        </div>
        <div class="voice-error" id="voice-error" hidden></div>
      </section>

      <section class="popup-section">
        <div class="section-heading section-heading-inline">
          <span>${escapeHtml(t("sectionRoomMembers"))}</span>
          <span class="section-meta" id="members-status">-</span>
        </div>
        <div class="member-list" id="member-list"></div>
      </section>

      <section class="popup-section popup-section-advanced">
        <details class="advanced-details">
          <summary class="advanced-summary">${escapeHtml(t("sectionAdvancedInfo"))}</summary>

          <div class="advanced-content">
            <div class="setting-group">
              <label class="field-label" for="server-url">${escapeHtml(t("metricServerUrl"))}</label>
              <div class="settings-row">
                <input id="server-url" placeholder="${escapeHtml(DEFAULT_SERVER_URL)}">
                <button class="secondary compact-button" id="save-server-url" type="button">${escapeHtml(t("actionSave"))}</button>
              </div>
            </div>

            <div class="info-grid">
              <div class="info-item">
                <span class="field-label">${escapeHtml(t("metricCurrentIdentity"))}</span>
                <span class="info-value" id="member-status">-</span>
              </div>
              <div class="info-item">
                <span class="field-label">${escapeHtml(t("metricReconnectCountdown"))}</span>
                <span class="info-value retry-status">
                  <span id="retry-status-value">-</span>
                  <span class="retry-status-count" id="retry-status-count"></span>
                </span>
              </div>
              <div class="info-item">
                <span class="field-label">${escapeHtml(t("metricClockSync"))}</span>
                <span class="info-value info-value-wide" id="clock-status">-</span>
                <span class="field-note">${escapeHtml(t("metricClockHelp"))}</span>
              </div>
            </div>

            <div class="logs-header">
              <div class="section-heading section-heading-small">${escapeHtml(t("sectionDebugLogs"))}</div>
              <button class="secondary compact-button copy-button" id="copy-logs" type="button">
                  <span class="button-icon-wrap" aria-hidden="true">
                    <svg class="button-icon button-icon-copy" viewBox="0 0 16 16">
                      <rect x="5" y="3" width="8" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"></rect>
                      <path d="M3.5 10.5V5.5C3.5 4.4 4.4 3.5 5.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"></path>
                    </svg>
                    <svg class="button-icon button-icon-check" viewBox="0 0 16 16">
                      <path d="M3.2 8.3L6.6 11.4L12.8 4.9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                    </svg>
                  </span>
                  <span class="button-label">${escapeHtml(t("actionCopy"))}</span>
              </button>
            </div>
            <div class="log-box" id="debug-logs">
              <div class="muted">${escapeHtml(t("stateNoLogs"))}</div>
            </div>
          </div>
        </details>
      </section>
    </div>
  `;
}
