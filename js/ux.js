/* VerbatimFx UX: setup, help, tutorial and first-run onboarding. */
(() => {
    const KEY = 'verbatimfx_tutorial_complete_v1';

    const $ = (id) => document.getElementById(id);

    function openDialog(id) {
        const el = $(id);
        if (el) el.classList.add('open');
    }

    function closeDialog(id) {
        const el = $(id);
        if (el) el.classList.remove('open');
    }

    async function testHardware() {
        const result = $('setupTestResult');
        if (!result) return;
        result.textContent = 'Checking audio and MIDI hardware...';
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
                throw new Error('This browser does not expose media device enumeration.');
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audio = devices.filter(d => d.kind === 'audioinput');
            const midi = window.AudioManager && window.AudioManager.midiAccess
                ? Array.from(window.AudioManager.midiAccess.inputs.values()) : [];
            result.innerHTML = `<strong>Hardware test complete.</strong><br>Audio inputs detected: ${audio.length}<br>MIDI inputs detected: ${midi.length}<br><span style="opacity:.8">If device names are hidden, use Hardware → Request Permissions.</span>`;
            if (window.App && App.refreshHardware) App.refreshHardware();
        } catch (error) {
            result.textContent = `Hardware test failed: ${error.message}`;
        }
    }

    const tutorialSteps = [
        ['Welcome to VerbatimFx', 'VerbatimFx is a browser-based audio and MIDI recording studio. This short tour shows the main workflow.'],
        ['1. Set up hardware', 'Open Setup to request microphone permissions, scan devices, and run the equipment test. Enable the inputs you want to monitor in Devices / Configuration.'],
        ['2. Monitor inputs', 'The Monitor / Waveform tab shows live level meters for enabled audio and MIDI inputs. Use aliases to give hardware readable names.'],
        ['3. Record', 'Use Master Record to capture the active audio or MIDI inputs. Stop Recording ends the capture and saves the resulting asset.'],
        ['4. Manage recordings', 'Recorded assets appear in the Recordings Sidebar. Open a project folder when you want VerbatimFx to work with a persistent project directory.'],
        ['5. Arrange and play', 'Use Playback / Timeline to place recordings into an arrangement, play or stop it, and export the mixdown as WAV.'],
        ['6. MIDI and SoundFonts', 'The Devices / Configuration panel includes MIDI monitoring, MIDI passthrough, and the SoundFont selector when SoundFont assets are available.'],
        ['You are ready', 'You can reopen this tour any time from Help → Tutorial. Setup and Help are always available from the top menu.']
    ];

    let tutorialIndex = 0;

    function renderTutorial() {
        const step = tutorialSteps[tutorialIndex];
        $('tutorialTitle').textContent = step[0];
        $('tutorialBody').textContent = step[1];
        $('tutorialProgress').style.width = `${((tutorialIndex + 1) / tutorialSteps.length) * 100}%`;
        $('tutorialBack').disabled = tutorialIndex === 0;
        $('tutorialNext').textContent = tutorialIndex === tutorialSteps.length - 1 ? 'Finish' : 'Next';
    }

    function openTutorial(firstRun = false) {
        tutorialIndex = 0;
        renderTutorial();
        openDialog('tutorialDialog');
        if (!firstRun) localStorage.removeItem(KEY);
    }

    function finishTutorial() {
        localStorage.setItem(KEY, '1');
        closeDialog('tutorialDialog');
    }

    function bind() {
        $('menuSetup').onclick = () => openDialog('setupDialog');
        $('menuHelp').onclick = () => openDialog('helpDialog');
        $('menuSetupPermissions').onclick = async () => {
            try {
                const granted = await window.AudioManager.requestPermissions();
                if (granted && window.App) App.refreshHardware();
            } catch (e) {
                if (window.App) App.showError('Permissions Error', e);
            }
        };
        $('menuSetupRescan').onclick = () => window.App && App.refreshHardware();
        $('menuSetupTest').onclick = () => openDialog('setupDialog') || testHardware();
        $('menuTutorial').onclick = () => openTutorial(false);
        $('setupRequestPermissions').onclick = async () => {
            try {
                const granted = await window.AudioManager.requestPermissions();
                if (granted && window.App) App.refreshHardware();
                testHardware();
            } catch (e) {
                if (window.App) App.showError('Permissions Error', e);
            }
        };
        $('setupRescan').onclick = () => { if (window.App) App.refreshHardware(); testHardware(); };
        $('setupTest').onclick = testHardware;
        $('helpClose').onclick = () => closeDialog('helpDialog');
        $('setupClose').onclick = () => closeDialog('setupDialog');
        $('tutorialBack').onclick = () => { if (tutorialIndex > 0) { tutorialIndex--; renderTutorial(); } };
        $('tutorialNext').onclick = () => {
            if (tutorialIndex < tutorialSteps.length - 1) { tutorialIndex++; renderTutorial(); }
            else finishTutorial();
        };
        $('tutorialSkip').onclick = finishTutorial;
        $('helpTutorial').onclick = () => { closeDialog('helpDialog'); openTutorial(false); };

        document.querySelectorAll('.ice-dialog-backdrop').forEach(backdrop => {
            backdrop.addEventListener('click', (event) => {
                if (event.target === backdrop && backdrop.dataset.dismissible !== 'false') backdrop.classList.remove('open');
            });
        });

        if (!localStorage.getItem(KEY)) {
            setTimeout(() => openTutorial(true), 450);
        }
    }

    window.addEventListener('load', bind, { once: true });
})();
