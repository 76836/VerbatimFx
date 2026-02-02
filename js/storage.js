/**
 * storage.js - Project and LocalStorage management
 */

const StorageManager = {
    projectHandle: null,
    settings: {
        soundFont: '',
        midiPassthrough: false,
        midiEnabled: {}
    },

    // Alias Management
    getAlias(deviceId) {
        return localStorage.getItem(`alias_${deviceId}`) || "";
    },

    setAlias(deviceId, alias) {
        if (!alias) {
            localStorage.removeItem(`alias_${deviceId}`);
        } else {
            localStorage.setItem(`alias_${deviceId}`, alias);
        }
    },

    // File System Access
    async selectProjectFolder() {
        try {
            this.projectHandle = await window.showDirectoryPicker();
            // Load Settings
            await this.loadSettings();
            return this.projectHandle;
        } catch (e) {
            console.error("User cancelled project selection", e);
            return null;
        }
    },

    async loadSettings() {
        if (!this.projectHandle) return;
        try {
            const handle = await this.projectHandle.getFileHandle('settings.json');
            const file = await handle.getFile();
            const text = await file.text();
            this.settings = JSON.parse(text);
        } catch (e) {
            // No settings file, ignore
        }
    },

    async saveSettings() {
        if (!this.projectHandle) return;
        try {
            const handle = await this.projectHandle.getFileHandle('settings.json', { create: true });
            const writable = await handle.createWritable();
            await writable.write(JSON.stringify(this.settings, null, 2));
            await writable.close();
        } catch (e) {
            console.error("Settings Save Error", e);
        }
    },

    async getAssets() {
        if (!this.projectHandle) return [];
        const assets = [];
        for await (const entry of this.projectHandle.values()) {
            if (entry.kind === 'file' && (
                entry.name.endsWith('.webm') ||
                entry.name.endsWith('.wav') ||
                entry.name.endsWith('.sf2') ||
                entry.name.endsWith('.midi.json')
            )) {
                assets.push(entry);
            }
        }
        return assets;
    },

    async loadSoundFont(name) {
        if (!this.projectHandle) return null;
        try {
            const handle = await this.projectHandle.getFileHandle(name);
            const file = await handle.getFile();
            return await file.arrayBuffer();
        } catch (e) {
            console.error("Failed to load soundfont", e);
            return null;
        }
    },

    async saveFile(name, blob) {
        if (!this.projectHandle) return;
        try {
            const handle = await this.projectHandle.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
        } catch (e) {
            console.error("Save File Error", e);
        }
    },

    async renameAsset(oldName, newName) {
        if (!this.projectHandle) return false;
        try {
            // 1. Get old file
            const oldHandle = await this.projectHandle.getFileHandle(oldName);
            const file = await oldHandle.getFile();

            // 2. Create new file
            const newHandle = await this.projectHandle.getFileHandle(newName, { create: true });
            const writable = await newHandle.createWritable();

            // 3. Copy content
            const buffer = await file.arrayBuffer();
            await writable.write(buffer);
            await writable.close();

            // 4. Delete old file
            await this.projectHandle.removeEntry(oldName);

            return true;
        } catch (e) {
            console.error("Rename Failed", e);
            alert("Rename failed: " + e.message);
            return false;
        }
    },

    async saveArrangement(data) {
        if (!this.projectHandle) return;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        await this.saveFile('arrangement.vfx', blob);
    },

    async loadArrangement() {
        if (!this.projectHandle) return null;
        try {
            const handle = await this.projectHandle.getFileHandle('arrangement.vfx');
            const file = await handle.getFile();
            const text = await file.text();
            return JSON.parse(text);
        } catch (e) {
            return null;
        }
    }
};

window.StorageManager = StorageManager;
