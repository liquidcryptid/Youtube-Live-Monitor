(async () => {
  console.log('Background script loaded');

  let liveChannels = [];
  let currentStream = null; // { channelId, videoId, tabId, obsAction }
  let ws = null; // WebSocket instance for OBS
  let isStopping = false; // Flag to prevent multiple stop attempts
  let isTabActive = false; // Flag to track if the tab is intentionally open for a live stream
  let lastTabAction = 0; // Timestamp of the last tab action to debounce
  let lastLiveStatus = {}; // Cache last known live status to handle fetch failures
  let pingInterval = null; // Interval ID for WebSocket pings
  let isIdentified = false; // Flag to track OBS identification status

  // Helper functions for storage
  function getStorageItem(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        resolve(result[key]);
      });
    });
  }

  function setStorageItem(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve();
      });
    });
  }

  // Create alarm with a shorter interval to keep service worker active
  chrome.alarms.create('checkLive', { periodInMinutes: 0.25 }); // 15-second interval

  // Persistent ping loop to keep service worker alive
  setInterval(() => {
    if (chrome.runtime?.id) {
      console.log('[YouTube Live Monitor] Keeping service worker alive with ping');
    }
  }, 10000); // Ping every 10 seconds

  // SHA-256 helper function for OBS authentication
  async function computeSha256(str) {
    const buffer = new TextEncoder().encode(str);
    return await crypto.subtle.digest('SHA-256', buffer);
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Function to check if a channel is live, with enhanced waiting lobby filtering
  async function isChannelLive(channelId, verboseLogging) {
    const liveUrl = `https://www.youtube.com/channel/${channelId}/live`;
    log(verboseLogging, `Fetching live status for channel ${channelId}: ${liveUrl}`);

    try {
      const response = await fetch(liveUrl, { method: 'GET', mode: 'no-cors' });
      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }
      const html = await response.text();
      log(verboseLogging, `Successfully fetched /live page for channel ${channelId}`);

      if (html.includes('"isLive":true')) {
        const canonicalMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([^"]+)">/);
        if (canonicalMatch) {
          const videoId = canonicalMatch[1];
          log(verboseLogging, `Found video ID: ${videoId} for channel ${channelId}`);

          // Enhanced waiting lobby detection
          const hasUpcoming = html.includes('ytp-upnext');
          const hasDvr = html.includes('"isLiveDvrEnabled":true');
          const hasScheduled = html.includes('"scheduledStartTime"') || html.includes('"upcomingEventData"');
          const isWaitingLobby = (hasUpcoming || hasScheduled) && !hasDvr; // Multiple lobby indicators
          if (isWaitingLobby) {
            log(verboseLogging, `Waiting lobby detected for channel ${channelId} with indicators: ytp-upnext=${hasUpcoming}, scheduled=${hasScheduled}, dvr=${hasDvr}`);
            // Recheck after a short delay
            await new Promise(resolve => setTimeout(resolve, 15000)); // 15-second delay
            const recheckResponse = await fetch(liveUrl, { method: 'GET', mode: 'no-cors' });
            const recheckHtml = await recheckResponse.text();
            const recheckHasUpcoming = recheckHtml.includes('ytp-upnext');
            const recheckHasScheduled = recheckHtml.includes('"scheduledStartTime"') || recheckHtml.includes('"upcomingEventData"');
            const recheckHasDvr = recheckHtml.includes('"isLiveDvrEnabled":true');
            if ((recheckHasUpcoming || recheckHasScheduled) && !recheckHasDvr) {
              log(verboseLogging, `Recheck confirmed waiting lobby for channel ${channelId}`);
              return { isLive: false };
            }
            log(verboseLogging, `Recheck detected live stream for channel ${channelId} with video ID ${videoId}`);
            return { isLive: true, videoId };
          }

          // Confirm live stream
          if (!hasUpcoming && !hasScheduled && (hasDvr || !html.includes('"upcomingEventData"'))) {
            log(verboseLogging, `Live stream confirmed for channel ${channelId} with video ID ${videoId}`);
            return { isLive: true, videoId };
          }

          log(verboseLogging, `Live stream detected for channel ${channelId} with video ID ${videoId} (pending recheck if needed)`);
          return { isLive: true, videoId };
        } else {
          log(verboseLogging, `Live stream detected but no video ID found for channel ${channelId}`);
          return { isLive: false };
        }
      }
      log(verboseLogging, `No live stream detected for channel ${channelId}`);
      return { isLive: false };
    } catch (error) {
      log(verboseLogging, `Error checking live status for ${channelId}: ${error.message}`);
      return { isLive: false };
    }
  }

  // Main function to check and manage live channels
  async function checkLiveStatus() {
    const { verboseLogging = false } = await chrome.storage.sync.get('verboseLogging');
    log(verboseLogging, 'Starting live status check');
    log(verboseLogging, `Verbose logging enabled: ${verboseLogging}`);

    const channelsResult = await chrome.storage.sync.get('channels');
    const channels = channelsResult.channels || [];
    const priorityChannelResult = await chrome.storage.sync.get('priorityChannel');
    const priorityChannel = priorityChannelResult.priorityChannel || null;
    log(verboseLogging, `Retrieved ${channels.length} channels from storage: ${JSON.stringify(channels)}`);
    log(verboseLogging, `Priority channel: ${priorityChannel}`);

    const liveChannels = [];
    for (const channel of channels) {
      const isLive = await isChannelLive(channel.id, verboseLogging);
      if (isLive.isLive && isLive.videoId) {
        liveChannels.push({ ...channel, videoId: isLive.videoId });
        lastLiveStatus[channel.id] = { isLive: true, videoId: isLive.videoId };
        log(verboseLogging, `Channel ${channel.displayName} (${channel.id}) is live with video ID ${isLive.videoId}`);
      } else if (lastLiveStatus[channel.id]?.isLive && !isLive.isLive) {
        log(verboseLogging, `Channel ${channel.displayName} (${channel.id}) may have ended, fetch failed`);
      } else {
        log(verboseLogging, `Channel ${channel.displayName} (${channel.id}) is not live`);
        delete lastLiveStatus[channel.id];
      }
    }

    log(verboseLogging, `Found ${liveChannels.length} live channels`);

    let selectedChannel = null;
    const currentLiveChannelId = await getStorageItem('currentLiveChannelId');
    log(verboseLogging, `Current live channel ID from storage: ${currentLiveChannelId}`);

    // Always select the highest-priority live channel based on list order
    for (const channel of channels) {
      const liveChannel = liveChannels.find(ch => ch.id === channel.id);
      if (liveChannel) {
        selectedChannel = liveChannel;
        break;
      }
    }

    if (!selectedChannel && liveChannels.length > 0) {
      // Fallback to first live channel if no match in order
      selectedChannel = liveChannels[0];
    }

    if (!selectedChannel) {
      log(verboseLogging, `No live channels, stopping streaming`);
      await stopObsStreaming(verboseLogging);
      await setStorageItem('currentLiveChannelId', null);
      currentStream = null;
      isTabActive = false;
      return;
    }

    // Check if we need to switch the tab
    const now = Date.now();
    if (now - lastTabAction < 30000 && currentLiveChannelId === selectedChannel.id) { // Debounce only if same channel
      log(verboseLogging, 'Tab action debounced, skipping');
      return;
    }

    chrome.tabs.query({ url: "*://*.youtube.com/*" }, async (tabs) => {
      const hasYouTubeTab = tabs.length > 0;
      log(verboseLogging, `Has YouTube tab: ${hasYouTubeTab}`);

      if (!hasYouTubeTab) {
        // Open new tab for selectedChannel
        chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${selectedChannel.videoId}` }, async (tab) => {
          log(verboseLogging, `Created tab with ID ${tab.id} for URL https://www.youtube.com/watch?v=${selectedChannel.videoId}`);
          currentStream = { channelId: selectedChannel.id, videoId: selectedChannel.videoId, tabId: tab.id, obsAction: selectedChannel.obsAction };
          await setStorageItem('currentLiveChannelId', selectedChannel.id);
          isTabActive = true;
          if (selectedChannel.obsAction !== 'no-obs') {
            await startObsStreaming(selectedChannel.obsAction, verboseLogging);
          }
          lastTabAction = now;
        });
      } else {
        // Reuse existing tab
        const tab = tabs[0];
        if (tab.url.includes(selectedChannel.videoId) && currentStream && currentStream.channelId === selectedChannel.id) {
          log(verboseLogging, `Tab ${tab.id} is already on video ${selectedChannel.videoId}, no action needed`);
          if (currentStream.obsAction !== selectedChannel.obsAction && selectedChannel.obsAction !== 'no-obs') {
            await startObsStreaming(selectedChannel.obsAction, verboseLogging);
          }
        } else {
          chrome.tabs.update(tab.id, { url: `https://www.youtube.com/watch?v=${selectedChannel.videoId}` });
          log(verboseLogging, `Updated tab ${tab.id} to video ${selectedChannel.videoId}`);
          currentStream = { channelId: selectedChannel.id, videoId: selectedChannel.videoId, tabId: tab.id, obsAction: selectedChannel.obsAction };
          await setStorageItem('currentLiveChannelId', selectedChannel.id);
          isTabActive = true;
          if (selectedChannel.obsAction !== 'no-obs') {
            await startObsStreaming(selectedChannel.obsAction, verboseLogging);
          }
          lastTabAction = now;
        }
      }

      // Update live channels in the options page
      try {
        chrome.runtime.sendMessage({ action: 'updateLiveChannels', liveChannels }, () => {
          if (chrome.runtime.lastError) {
            log(verboseLogging, `Failed to send updateLiveChannels message: ${chrome.runtime.lastError.message}`);
          } else {
            log(verboseLogging, 'Sent updateLiveChannels message to options page');
          }
        });
      } catch (error) {
        log(verboseLogging, `Error sending updateLiveChannels message: ${error.message}`);
      }
    });
  }

  // Function to ensure OBS WebSocket connection is established
  async function ensureObsConnected(verboseLogging) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get('obsSettings', ({ obsSettings }) => {
        if (!obsSettings || !obsSettings.host || !obsSettings.port) {
          log(verboseLogging, 'OBS settings not configured. Please set host and port in options.');
          reject(new Error('OBS settings not configured'));
          return;
        }
        log(verboseLogging, `Attempting connection to OBS at ${obsSettings.host}:${obsSettings.port}, password: ${obsSettings.password ? 'set' : 'not set'}`);
        const { host, port, password } = obsSettings;
        const wsUrl = `ws://${host}:${port}`;

        if (ws && ws.readyState === WebSocket.OPEN && isIdentified) {
          log(verboseLogging, 'WebSocket already open and identified');
          resolve();
          return;
        }

        if (ws && (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED)) {
          log(verboseLogging, 'Previous WebSocket connection closed, resetting');
          ws = null;
        }

        if (!ws) {
          log(verboseLogging, `Creating new WebSocket connection to ${wsUrl}`);
          ws = new WebSocket(wsUrl);
        }

        ws.onopen = () => {
          log(verboseLogging, 'WebSocket connection opened');
        };

        ws.onmessage = async (event) => {
          const message = JSON.parse(event.data);
          log(verboseLogging, `Received message: ${JSON.stringify(message)}`);
          if (message.op === 0) { // Hello
            if (message.d.authentication) {
              const { salt, challenge } = message.d.authentication;
              log(verboseLogging, `Authentication required. Salt: ${salt}, Challenge: ${challenge}`);
              try {
                const secretHash = await computeSha256(password + salt);
                const secret = arrayBufferToBase64(secretHash);
                log(verboseLogging, `Computed secret: ${secret}`);
                const authHash = await computeSha256(secret + challenge);
                const auth = arrayBufferToBase64(authHash);
                log(verboseLogging, `Computed auth: ${auth}`);
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    op: 1,
                    d: {
                      rpcVersion: 1,
                      authentication: auth,
                      eventSubscriptions: 0
                    }
                  }));
                  log(verboseLogging, 'Sent Identify message');
                } else {
                  log(verboseLogging, 'WebSocket not open, cannot send Identify message');
                  reject(new Error('WebSocket not open'));
                }
              } catch (error) {
                log(verboseLogging, `Error computing authentication: ${error.message}`);
                reject(error);
              }
            } else {
              log(verboseLogging, 'No authentication required');
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  op: 1,
                  d: {
                    rpcVersion: 1,
                    eventSubscriptions: 0
                  }
                }));
                log(verboseLogging, 'Sent Identify message');
              } else {
                log(verboseLogging, 'WebSocket not open, cannot send Identify message');
                reject(new Error('WebSocket not open'));
              }
            }
          } else if (message.op === 2) { // Identified
            log(verboseLogging, 'Identified successfully');
            isIdentified = true;
            if (!pingInterval) {
              pingInterval = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 9, d: { eventType: "Ping" } }));
                  log(verboseLogging, 'Sent WebSocket ping to keep connection alive');
                }
              }, 10000); // Ping every 10 seconds
            }
            resolve();
          } else if (message.op === 7) { // RequestResponse
            if (message.d.requestType === "StartStream" || message.d.requestType === "StartRecord") {
              if (message.d.requestStatus.result) {
                log(verboseLogging, `OBS ${message.d.requestType === "StartStream" ? "streaming" : "recording"} started successfully`);
              } else {
                log(verboseLogging, `Failed to ${message.d.requestType === "StartStream" ? "start streaming" : "start recording"}: ${JSON.stringify(message.d.requestStatus)}`);
              }
            } else if (message.d.requestType === "StopStream" || message.d.requestType === "StopRecord") {
              if (message.d.requestStatus.result) {
                log(verboseLogging, `OBS ${message.d.requestType === "StopStream" ? "streaming" : "recording"} stopped successfully`);
              } else {
                log(verboseLogging, `Failed to ${message.d.requestType === "StopStream" ? "stop streaming" : "stop recording"}: ${JSON.stringify(message.d.requestStatus)}`);
              }
            }
          }
        };

        ws.onerror = (error) => {
          const errorMsg = error.message || error;
          if (errorMsg.includes('ERR_CONNECTION_REFUSED')) {
            log(verboseLogging, `WebSocket connection failed: ${errorMsg}`);
            resolve(); // Resolve silently for connection refused
          } else {
            log(verboseLogging, `WebSocket error: ${errorMsg}`);
            reject(error); // Reject for other errors
          }
        };

        ws.onclose = (event) => {
          log(verboseLogging, `WebSocket connection closed: code ${event.code}, reason ${event.reason}`);
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }
          isIdentified = false;
          ws = null;
          resolve(); // Resolve on close to avoid unhandled rejection
        };
      });
    });
  }

  // Function to start OBS streaming or recording based on action
  async function startObsStreaming(action, verboseLogging) {
    try {
      log(verboseLogging, `Attempting to start OBS ${action}`);
      await ensureObsConnected(verboseLogging);
      if (ws && ws.readyState === WebSocket.OPEN) {
        const requestType = action === 'stream' ? 'StartStream' : 'StartRecord';
        ws.send(JSON.stringify({
          op: 6,
          d: {
            requestType: requestType,
            requestId: `${requestType.toLowerCase()}_request`
          }
        }));
        log(verboseLogging, `Sent ${requestType} request`);
      } else {
        log(verboseLogging, `WebSocket not open (state: ${ws ? ws.readyState : 'null'}), cannot send ${action} request`);
      }
    } catch (error) {
      log(verboseLogging, `Error starting OBS ${action}: ${error.message}`);
    }
  }

  // Function to stop OBS streaming or recording
  async function stopObsStreaming(verboseLogging) {
    if (isStopping) {
      log(verboseLogging, 'Stop streaming/recording already in progress, skipping');
      return;
    }
    isStopping = true;

    try {
      log(verboseLogging, 'Attempting to stop OBS streaming and recording');
      await ensureObsConnected(verboseLogging);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          op: 6,
          d: {
            requestType: "StopStream",
            requestId: "stop_stream"
          }
        }));
        ws.send(JSON.stringify({
          op: 6,
          d: {
            requestType: "StopRecord",
            requestId: "stop_record"
          }
        }));
        log(verboseLogging, 'Sending StopStream and StopRecord requests to OBS');
      } else {
        log(verboseLogging, 'WebSocket not open after reconnect attempt, cannot stop streaming/recording');
      }
    } catch (error) {
      log(verboseLogging, `Error stopping OBS: ${error.message}`);
    } finally {
      isStopping = false;
    }
  }

  // Logging function
  function log(verbose, message) {
    if (verbose) {
      console.log(`[YouTube Live Monitor] ${message}`);
    }
  }

  // Message listener for settings
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'getSettings') {
      console.log('[Background] Received getSettings request');
      chrome.storage.sync.get(['channels', 'obsSettings', 'verboseLogging', 'priorityChannel'], (result) => {
        if (chrome.runtime.lastError) {
          console.error('Error fetching settings:', chrome.runtime.lastError);
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          console.log('[Background] Sending settings:', result);
          sendResponse({
            channels: result.channels || [],
            obsSettings: result.obsSettings || { host: 'localhost', port: '4455', password: '' },
            verboseLogging: result.verboseLogging || false,
            priorityChannel: result.priorityChannel || null
          });
        }
      });
      return true;
    } else if (message.action === 'openChannel') {
      chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${message.videoId}` });
    }
  });

  // Open options page on action click
  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage();
  });

  // Listen for alarm
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'checkLive') {
      console.log('Live status check alarm fired');
      checkLiveStatus();
    }
  });
})();