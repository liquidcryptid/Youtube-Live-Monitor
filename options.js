document.getElementById('add-channel').addEventListener('click', () => {
  const div = document.createElement('div');
  div.className = 'channel-input';
  div.draggable = true;
  div.innerHTML = `
    <span class="drag-handle">☰</span>
    <input type="text" class="display-name" placeholder="Display name">
    <input type="hidden" class="channel-id" value="">
    <select class="obs-action">
      <option value="no-obs" selected>No OBS</option>
      <option value="stream">Stream</option>
      <option value="record">Record</option>
    </select>
    <button class="remove">Remove</button>
  `;
  document.getElementById('channels').appendChild(div);
});

document.getElementById('channels').addEventListener('click', (e) => {
  if (e.target.className === 'remove') {
    e.target.parentElement.remove();
  }
});

document.getElementById('channels').addEventListener('dragstart', (e) => {
  if (e.target.className.includes('channel-input')) {
    e.target.classList.add('dragging');
    e.dataTransfer.setData('text/plain', e.target.innerHTML);
  }
});

document.getElementById('channels').addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.getElementById('channels').addEventListener('drop', (e) => {
  e.preventDefault();
  const dragging = document.querySelector('.dragging');
  if (dragging) {
    const target = e.target.closest('.channel-input');
    if (target && target !== dragging) {
      const containers = Array.from(document.querySelectorAll('.channel-input'));
      const draggingIndex = containers.indexOf(dragging);
      const targetIndex = containers.indexOf(target);
      if (draggingIndex > -1 && targetIndex > -1) {
        if (draggingIndex < targetIndex) {
          target.parentNode.insertBefore(dragging, target.nextSibling);
        } else {
          target.parentNode.insertBefore(dragging, target);
        }
      }
    }
    dragging.classList.remove('dragging');
  }
});

document.getElementById('save').addEventListener('click', async () => {
  const inputs = document.querySelectorAll('.channel-input');
  const channels = [];
  let priorityChannel = null;
  const obsSettings = {
    host: document.getElementById('obs-host').value.trim() || 'localhost',
    port: document.getElementById('obs-port').value.trim() || '4455',
    password: document.getElementById('obs-password').value.trim()
  };
  const verboseLogging = document.getElementById('verbose-logging').checked;

  for (const inputDiv of inputs) {
    const displayNameInput = inputDiv.querySelector('.display-name').value.trim();
    const channelIdInput = inputDiv.querySelector('.channel-id');
    const obsAction = inputDiv.querySelector('.obs-action').value;

    if (displayNameInput) {
      let channelId = channelIdInput.value || await getChannelIdFromDisplayName(displayNameInput);
      if (channelId) {
        channels.push({ id: channelId, displayName: displayNameInput, obsAction });
        channelIdInput.value = channelId; // Store the resolved ID
      } else {
        alert(`Could not find channel ID for ${displayNameInput}`);
      }
    }
  }

  // The first channel (highest in the list) is the implicit priority if none is set
  if (channels.length > 0 && !priorityChannel) {
    priorityChannel = channels[0].id;
  }

  chrome.storage.sync.set({ channels, priorityChannel, obsSettings, verboseLogging }, () => {
    alert('Settings saved');
  });
});

// Updated function to fetch channel ID from display name
async function getChannelIdFromDisplayName(displayName) {
  const username = displayName.replace(/^@/, ''); // Remove @ if present
  const url = `https://www.youtube.com/@${username}`;
  try {
    const response = await fetch(url);
    const html = await response.text();
    const match = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})">/);
    if (match) {
      return match[1];
    }
  } catch (error) {
    console.error('Error fetching channel page for display name:', error);
  }
  return null;
}

function isChannelId(str) {
  return /^UC[\w-]{22}$/.test(str);
}

chrome.runtime.sendMessage({ action: 'getSettings' }, (response) => {
  if (chrome.runtime.lastError) {
    console.error('Error retrieving settings:', chrome.runtime.lastError.message);
    populateSettings([], null, { host: 'localhost', port: '4455', password: '' }, false);
    return;
  }
  if (response.error) {
    console.error('Background script error:', response.error);
    populateSettings([], null, { host: 'localhost', port: '4455', password: '' }, false);
    return;
  }
  const { channels = [], priorityChannel = null, obsSettings = { host: 'localhost', port: '4455', password: '' }, verboseLogging = false } = response;
  populateSettings(channels, priorityChannel, obsSettings, verboseLogging);
});

function populateSettings(channels, priorityChannel, obsSettings, verboseLogging) {
  const channelsContainer = document.getElementById('channels');
  channelsContainer.innerHTML = '';

  if (channels.length === 0) {
    addDefaultChannelInput();
  } else {
    channels.forEach(channel => {
      const div = document.createElement('div');
      div.className = 'channel-input';
      div.draggable = true;
      div.innerHTML = `
        <span class="drag-handle">☰</span>
        <input type="text" class="display-name" value="${channel.displayName}" placeholder="Display name">
        <input type="hidden" class="channel-id" value="${channel.id}">
        <select class="obs-action">
          <option value="no-obs" ${channel.obsAction === 'no-obs' ? 'selected' : ''}>No OBS</option>
          <option value="stream" ${channel.obsAction === 'stream' ? 'selected' : ''}>Stream</option>
          <option value="record" ${channel.obsAction === 'record' ? 'selected' : ''}>Record</option>
        </select>
        <button class="remove">Remove</button>
      `;
      channelsContainer.appendChild(div);
    });
  }

  document.getElementById('obs-host').value = obsSettings.host || 'localhost';
  document.getElementById('obs-port').value = obsSettings.port || '4455';
  document.getElementById('obs-password').value = obsSettings.password || '';
  document.getElementById('verbose-logging').checked = verboseLogging || false;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateLiveChannels') {
    const liveChannels = message.liveChannels;
    const container = document.getElementById('live-channels');
    if (liveChannels.length === 0) {
      container.innerHTML = 'No channels are live.';
    } else {
      container.innerHTML = '';
      liveChannels.forEach(channel => {
        const button = document.createElement('button');
        button.textContent = `Watch ${channel.displayName}`;
        button.addEventListener('click', () => {
          chrome.runtime.sendMessage({
            action: 'openChannel',
            channelId: channel.id,
            videoId: channel.videoId
          });
        });
        container.appendChild(button);
      });
    }
  }
});

function addDefaultChannelInput() {
  const div = document.createElement('div');
  div.className = 'channel-input';
  div.draggable = true;
  div.innerHTML = `
    <span class="drag-handle">☰</span>
    <input type="text" class="display-name" placeholder="Display name">
    <input type="hidden" class="channel-id" value="">
    <select class="obs-action">
      <option value="no-obs" selected>No OBS</option>
      <option value="stream">Stream</option>
      <option value="record">Record</option>
    </select>
    <button class="remove">Remove</button>
  `;
  document.getElementById('channels').appendChild(div);
}