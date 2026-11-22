'use strict';

/**
 * src/mcp/tools.js
 *
 * Full-parity Model Context Protocol (MCP) tool & resource catalog for Power Pilot.
 * Exposes 100% of headless REST capabilities (62 tools + 11 live resources) cleanly.
 */

const { POWER_ACTIONS } = require('../cli/commands');

const TOOLS = Object.freeze([
    // --- Core Status & Power ---
    {
        name: 'powerpilot_status',
        description: 'Get Power Pilot daemon/app status, version, headless mode flag, active tasks count, and transport posture.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_power_action',
        description: 'Trigger an immediate safety-checked power action (shutdown, restart, sleep, hibernate, lock, signout) through the task pipeline.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: POWER_ACTIONS, description: 'Power action to execute.' }
            },
            required: ['action'],
            additionalProperties: false
        }
    },

    // --- Full Task Management & Complex Automation ---
    {
        name: 'powerpilot_list_tasks',
        description: 'List active, scheduled, paused, and historical automation tasks with optional status filter and pagination.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 500 },
                offset: { type: 'integer', minimum: 0 },
                status: { type: 'string', description: 'Optional status filter (scheduled, monitoring, disabled, completed, cancelled, snoozed, waiting, failed, expired).' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_schedule_timer',
        description: 'Schedule a countdown power action (shutdown, restart, sleep, hibernate, lock, signout).',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: POWER_ACTIONS },
                minutes: { type: 'integer', minimum: 1, maximum: 34560 },
                durationMs: { type: 'integer', minimum: 1000, maximum: 2073600000 },
                name: { type: 'string', maxLength: 120 }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_create_task',
        description: 'Create a full automation task with any trigger (duration, scheduled_time + recurrence) or SmartFinish conditionGroup (process_running, cpu_usage, network_speed, disk_activity, file_stable, directory_idle, user_idle, battery_level), warningConfig, safetyPolicy, snoozeConfig, or action chain.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', maxLength: 120 },
                action: { type: 'string', enum: POWER_ACTIONS },
                trigger: { type: 'object', description: 'Trigger object, e.g. { type: "duration", durationMs: 600000 } or { type: "scheduled_time", targetTime: 1790000000000 } or { type: "composite" }.' },
                conditionGroup: { type: 'object', description: 'SmartFinish condition group: { operator: "AND"|"OR", stabilitySeconds: 60, conditions: [...] }.' },
                recurrence: { type: 'object', description: 'Recurrence rule: { enabled: true, frequency: "daily"|"weekly"|"weekdays"|"weekends"|"custom", timeOfDay: "23:30", daysOfWeek: [1,2,3,4,5] }.' },
                warningConfig: { type: 'object' },
                safetyPolicy: { type: 'object' },
                snoozeConfig: { type: 'object' },
                chain: { type: 'array', items: { type: 'object' }, maxItems: 5 }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_cancel_timer',
        description: 'Cancel a scheduled or active Power Pilot task by its taskId (supply pin if Cancel PIN lock is configured).',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Task ID to cancel.' },
                pin: { type: 'string', description: 'Optional Cancel PIN if PIN lock is configured.' }
            },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_pause_task',
        description: 'Pause a specific scheduled or monitoring automation task without deleting it.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_resume_task',
        description: 'Resume a paused automation task.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_snooze_task',
        description: 'Snooze an active or scheduled task by 1 to 1440 minutes.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                minutes: { type: 'integer', minimum: 1, maximum: 1440 }
            },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_run_task_now',
        description: 'Immediately run an existing task through the full safety and warning pipeline.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_delete_task',
        description: 'Permanently delete a non-running task record by taskId.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_clear_finished_tasks',
        description: 'Remove all terminal (completed, cancelled, failed, blocked, expired) tasks.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_pause_all',
        description: 'Toggle or explicitly set global automation pause kill-switch (supply pin if Cancel PIN lock is configured).',
        inputSchema: {
            type: 'object',
            properties: {
                paused: { type: 'boolean', description: 'Set true to pause all automation, false to resume; omit to toggle.' },
                pin: { type: 'string', description: 'Optional Cancel PIN if PIN lock is configured.' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_warning_status',
        description: 'Inspect any active pre-action warning countdown state.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_warning_action',
        description: 'Interact with an active pre-action warning countdown (confirm, snooze, or cancel; enforces Cancel PIN if configured).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['confirm', 'snooze', 'cancel'] },
                taskId: { type: 'string' },
                minutes: { type: 'integer', minimum: 1, maximum: 1440 },
                pin: { type: 'string' }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },

    // --- Templates ---
    {
        name: 'powerpilot_list_templates',
        description: 'List built-in and custom automation templates.',
        inputSchema: {
            type: 'object',
            properties: { includeHidden: { type: 'boolean' } },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_save_template',
        description: 'Create a custom automation template or override a built-in template.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                name: { type: 'string', maxLength: 80 },
                description: { type: 'string', maxLength: 200 },
                action: { type: 'string', enum: POWER_ACTIONS },
                category: { type: 'string' },
                icon: { type: 'string' },
                trigger: { type: 'object' },
                defaultCondition: { type: 'object' },
                defaultConditionGroup: { type: 'object' },
                schedule: { type: 'object' }
            },
            required: ['name', 'action'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_delete_template',
        description: 'Delete a user template or hide a built-in template.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_run_template',
        description: 'Instantiate and start a live automation task directly from a template ID.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string' },
                name: { type: 'string', maxLength: 120 },
                warningConfig: { type: 'object' },
                safetyPolicy: { type: 'object' }
            },
            required: ['id'],
            additionalProperties: false
        }
    },

    // --- Settings & Security ---
    {
        name: 'powerpilot_get_settings',
        description: 'Read all Power Pilot settings (secrets are redacted; secretPresence booleans included).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_update_settings',
        description: 'Update one or more Power Pilot settings (admin role required; schema-validated).',
        inputSchema: {
            type: 'object',
            properties: { patch: { type: 'object', description: 'Key-value map of settings to update.' } },
            required: ['patch'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_update_security_settings',
        description: 'Update security flags such as autonomyMode, agentDisabled, automationPaused, localApiTlsEnabled (admin role required).',
        inputSchema: {
            type: 'object',
            properties: { patch: { type: 'object' } },
            required: ['patch'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_security_status',
        description: 'Inspect TLS/mTLS, API key rotation status, PIN protection, storage health, and audit integrity status.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },

    // --- History, Energy Statistics, Health ---
    {
        name: 'powerpilot_get_history',
        description: 'Retrieve execution history with optional limit, action, and resultCode filters.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 500 },
                action: { type: 'string', enum: POWER_ACTIONS },
                resultCode: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_clear_history',
        description: 'Clear stored execution history records (admin role required).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_get_statistics',
        description: 'Get energy savings statistics (saved hours, kWh, monetary cost, CO2 avoided).',
        inputSchema: {
            type: 'object',
            properties: { days: { type: 'integer', minimum: 1, maximum: 3650 } },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_get_health',
        description: 'Get local reliability and automation health summary.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },

    // --- Wake-on-LAN, Webhooks, UPS ---
    {
        name: 'powerpilot_wol_list_devices',
        description: 'List saved Wake-on-LAN target devices.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_wol_save_devices',
        description: 'Save Wake-on-LAN device profiles list (max 32 devices).',
        inputSchema: {
            type: 'object',
            properties: { devices: { type: 'array', items: { type: 'object' }, maxItems: 32 } },
            required: ['devices'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_wol_send',
        description: 'Send a Wake-on-LAN magic packet by MAC address or saved deviceId/name.',
        inputSchema: {
            type: 'object',
            properties: {
                macAddress: { type: 'string' },
                deviceId: { type: 'string' },
                name: { type: 'string' },
                broadcastIp: { type: 'string' },
                port: { type: 'integer', minimum: 1, maximum: 65535 }
            },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_webhooks_list',
        description: 'List configured HTTPS webhooks with secrets redacted (admin role required).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_webhooks_save',
        description: 'Save validated HTTPS webhook endpoints (SSRF-guarded, admin role required).',
        inputSchema: {
            type: 'object',
            properties: { webhooks: { type: 'array', items: { type: 'object' }, maxItems: 20 } },
            required: ['webhooks'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_webhook_test',
        description: 'Send a live test payload to an HTTPS webhook endpoint (admin role required).',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                hmacSecret: { type: 'string' },
                bearerToken: { type: 'string' },
                events: { type: 'array', items: { type: 'string' } },
                enabled: { type: 'boolean' }
            },
            required: ['url'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_ups_test',
        description: 'Query a local or network NUT UPS daemon for battery/status telemetry.',
        inputSchema: {
            type: 'object',
            properties: {
                host: { type: 'string' },
                ups: { type: 'string' }
            },
            additionalProperties: false
        }
    },

    // --- Cloud Backup & Sync ---
    {
        name: 'powerpilot_cloud_status',
        description: 'Inspect serverless cloud backup status (OneDrive, Google Drive, Dropbox, iCloud, 15-day backups).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_cloud_action',
        description: 'Control serverless cloud backup & sync (connect, disconnect, sync, restore, set_provider, set_autosync).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['connect', 'disconnect', 'sync', 'restore', 'set_provider', 'set_autosync'] },
                force: { type: 'boolean' },
                connect: { type: 'boolean' },
                providerId: { type: 'string', enum: ['onedrive', 'gdrive', 'googledrive', 'dropbox', 'icloud', 'default'] },
                enabled: { type: 'boolean' }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },

    // --- Offline AI, Docs RAG, Diagnostics, Updates ---
    {
        name: 'powerpilot_ai_parse',
        description: 'Parse a natural-language power command offline (e.g., "shutdown in 45 minutes") and optionally execute it immediately.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', maxLength: 4000 },
                execute: { type: 'boolean', description: 'If true, immediately creates the parsed task.' }
            },
            required: ['text'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_ai_assist',
        description: 'Run the local multi-agent assistant (commands, templates, docs QA, diagnosis, energy insights).',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', maxLength: 4000 },
                intentHint: { type: 'string' },
                lang: { type: 'string' }
            },
            required: ['text'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_ai_diagnose',
        description: 'Diagnose why the last power action was blocked or did not run.',
        inputSchema: {
            type: 'object',
            properties: {
                reason: { type: 'string', maxLength: 4000 },
                lang: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_docs_search',
        description: 'Search Power Pilot offline documentation knowledge base (RAG).',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', maxLength: 300 },
                lang: { type: 'string' },
                topK: { type: 'integer', minimum: 1, maximum: 10 }
            },
            required: ['query'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_diagnostics',
        description: 'Read sanitized diagnostics snapshot, clear logs, or create a masked ZIP support bundle (admin role required).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['snapshot', 'clear', 'create_bundle'] }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_updates',
        description: 'Check update status or trigger an update check (respects distribution channel).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['status', 'check'] }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },

    // --- Enterprise Audit, Inventory, Orders, Exemptions, Maintenance Windows ---
    {
        name: 'powerpilot_audit_log',
        description: 'Read paginated tamper-evident HMAC-SHA256 audit log entries (admin role required).',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 500 },
                beforeSeq: { type: 'integer', minimum: 1 },
                verify: { type: 'boolean' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_audit_verify',
        description: 'Verify the integrity of the local HMAC-SHA256 tamper-evident audit log chain.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_inventory',
        description: 'Retrieve local device hardware/OS inventory and power capabilities.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_pending_orders',
        description: 'List pending signed enterprise console orders.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_manage_exemptions',
        description: 'List, grant, or revoke safety policy exemptions (write requires admin role).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['list', 'add', 'delete'] },
                id: { type: 'string' },
                exemption: { type: 'object' }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_manage_maintenance_windows',
        description: 'List, add, or remove maintenance windows (write requires admin role).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['list', 'add', 'delete'] },
                id: { type: 'string' },
                window: { type: 'object' }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_reset_template',
        description: 'Reset an edited built-in automation template back to factory defaults.',
        inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_restore_templates',
        description: 'Restore hidden built-in templates (and optionally reset all built-in edits).',
        inputSchema: {
            type: 'object',
            properties: { resetEdits: { type: 'boolean' } },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_submit_order',
        description: 'Submit an Ed25519-signed enterprise console order to the local queue.',
        inputSchema: {
            type: 'object',
            properties: {
                order: { type: 'object' },
                signature: { type: 'string' },
                keyId: { type: 'string' },
                idempotencyKey: { type: 'string' }
            },
            required: ['order', 'signature'],
            additionalProperties: true
        }
    },
    {
        name: 'powerpilot_ai_status',
        description: 'Inspect local AI LLM/STT model installation, memory readiness, and background download progress.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_ai_model',
        description: 'Manage local SHA-256 verified AI models: download bundle, load GGUF into RAM, or unload (admin role required).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['download', 'load', 'unload'] }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_ai_insights',
        description: 'Run local AI energy advisor, history-based automation recommender, or dismiss a suggestion topic.',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['energy', 'suggest', 'dismiss'] },
                lang: { type: 'string' },
                topic: { type: 'string', maxLength: 80 }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_device_estimate',
        description: 'Profile device hardware wattage and optionally save it to Energy settings.',
        inputSchema: {
            type: 'object',
            properties: { apply: { type: 'boolean' } },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_console_sync',
        description: 'Trigger an immediate enterprise console sync and drain signed orders (admin role required).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'powerpilot_updates_manage',
        description: 'Download update package, toggle install-on-quit, or install downloaded update now (admin role required).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['download', 'install_on_quit', 'install_now'] },
                enabled: { type: 'boolean' },
                pin: { type: 'string' }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_cloud_folder',
        description: 'Configure custom local cloud backup folder, reset to auto-detected default, or dismiss fresh-install recovery (admin role required).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['set', 'reset', 'dismiss_recovery'] },
                dirPath: { type: 'string', maxLength: 512 }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_export_data',
        description: 'Export sanitized settings (admin only, secrets stripped) or custom templates as JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', enum: ['settings', 'templates'] }
            },
            required: ['target'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_import_data',
        description: 'Import validated settings JSON (admin only) or merge custom templates JSON.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', enum: ['settings', 'templates'] },
                payload: { type: 'object' }
            },
            required: ['target', 'payload'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_cancel_pin',
        description: 'Inspect, configure, rotate, or clear Argon2id Cancel PIN lock (write requires admin role).',
        inputSchema: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['status', 'set', 'clear'] },
                pin: { type: 'string' },
                currentPin: { type: 'string' }
            },
            required: ['operation'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_rotate_api_key',
        description: 'Rotate the Local REST API key immediately and refresh cli-connection.json (admin role required).',
        inputSchema: {
            type: 'object',
            properties: {
                role: { type: 'string', enum: ['viewer', 'operator', 'admin'] },
                saveProfile: { type: 'boolean' }
            },
            additionalProperties: false
        }
    }
]);

const RESOURCES = Object.freeze([
    { uri: 'powerpilot://status', name: 'Power Pilot Status', description: 'Live status of Power Pilot daemon/desktop service.', mimeType: 'application/json' },
    { uri: 'powerpilot://tasks', name: 'Power Pilot Tasks', description: 'Active, scheduled, paused, and historical automation tasks.', mimeType: 'application/json' },
    { uri: 'powerpilot://settings', name: 'Power Pilot Settings', description: 'Redacted settings snapshot and secretPresence flags.', mimeType: 'application/json' },
    { uri: 'powerpilot://templates', name: 'Power Pilot Templates', description: 'Built-in and custom automation templates.', mimeType: 'application/json' },
    { uri: 'powerpilot://statistics', name: 'Energy Statistics', description: 'Saved hours, kWh, cost, and CO2 metrics.', mimeType: 'application/json' },
    { uri: 'powerpilot://history', name: 'Execution History', description: 'Recent task execution history records.', mimeType: 'application/json' },
    { uri: 'powerpilot://cloud-status', name: 'Cloud Backup Status', description: 'OneDrive / multi-cloud serverless backup & sync status.', mimeType: 'application/json' },
    { uri: 'powerpilot://health', name: 'Local Health Summary', description: 'Local reliability and success rate metrics.', mimeType: 'application/json' },
    { uri: 'powerpilot://warning', name: 'Active Warning State', description: 'Live pre-action warning countdown state (null when idle).', mimeType: 'application/json' },
    { uri: 'powerpilot://ai-status', name: 'Local AI Status', description: 'Installed GGUF/Whisper model status, RAM readiness, and download progress.', mimeType: 'application/json' },
    { uri: 'powerpilot://security', name: 'Security Posture', description: 'TLS/mTLS, API key rotation, Cancel PIN, autonomy, and audit integrity.', mimeType: 'application/json' }
]);

const RESOURCE_PATHS = Object.freeze({
    'powerpilot://status': '/status',
    'powerpilot://tasks': '/tasks',
    'powerpilot://settings': '/settings',
    'powerpilot://templates': '/templates',
    'powerpilot://statistics': '/statistics',
    'powerpilot://history': '/history',
    'powerpilot://cloud-status': '/cloud/status',
    'powerpilot://health': '/health',
    'powerpilot://warning': '/warning',
    'powerpilot://ai-status': '/ai/status',
    'powerpilot://security': '/security/status'
});

async function executeToolCall(name, args = {}, requestApi) {
    switch (name) {
        case 'powerpilot_status':
            return requestApi('GET', '/status');
        case 'powerpilot_power_action':
            if (!POWER_ACTIONS.includes(args.action)) throw new Error(`Invalid action: ${args.action}`);
            return requestApi('POST', `/power/${args.action}`);
        case 'powerpilot_list_tasks': {
            const qs = new URLSearchParams();
            if (args.limit !== undefined) qs.set('limit', String(args.limit));
            if (args.offset !== undefined) qs.set('offset', String(args.offset));
            if (args.status) qs.set('status', String(args.status));
            return requestApi('GET', qs.toString() ? `/tasks?${qs}` : '/tasks');
        }
        case 'powerpilot_schedule_timer': {
            const action = args.action || 'shutdown';
            if (!POWER_ACTIONS.includes(action)) throw new Error(`Invalid action: ${action}`);
            const durationMs = args.durationMs !== undefined ? Number(args.durationMs) : Number(args.minutes || 45) * 60000;
            if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error('durationMs or minutes must be a positive integer');
            const body = { action, durationMs };
            if (typeof args.name === 'string' && args.name.trim()) body.name = args.name.trim();
            return requestApi('POST', '/tasks/timer', body);
        }
        case 'powerpilot_create_task':
            return requestApi('POST', '/tasks', args);
        case 'powerpilot_cancel_timer':
            if (!args.id) throw new Error('id is required');
            return requestApi('POST', `/tasks/${encodeURIComponent(args.id)}/cancel`, args.pin ? { pin: args.pin } : null);
        case 'powerpilot_pause_task':
            if (!args.id) throw new Error('id is required');
            return requestApi('POST', `/tasks/${encodeURIComponent(args.id)}/pause`);
        case 'powerpilot_resume_task':
            if (!args.id) throw new Error('id is required');
            return requestApi('POST', `/tasks/${encodeURIComponent(args.id)}/resume`);
        case 'powerpilot_snooze_task':
            if (!args.id) throw new Error('id is required');
            return requestApi('POST', `/tasks/${encodeURIComponent(args.id)}/snooze`, { minutes: args.minutes !== undefined ? Number(args.minutes) : 10 });
        case 'powerpilot_run_task_now':
            if (!args.id) throw new Error('id is required');
            return requestApi('POST', `/tasks/${encodeURIComponent(args.id)}/run-now`);
        case 'powerpilot_delete_task':
            if (!args.id) throw new Error('id is required');
            return requestApi('DELETE', `/tasks/${encodeURIComponent(args.id)}`);
        case 'powerpilot_clear_finished_tasks':
            return requestApi('POST', '/tasks/clear-finished');
        case 'powerpilot_pause_all':
            return requestApi('POST', '/tasks/pause-all', {
                ...(typeof args.paused === 'boolean' ? { paused: args.paused } : {}),
                ...(args.pin ? { pin: args.pin } : {})
            });
        case 'powerpilot_warning_status':
            return requestApi('GET', '/warning');
        case 'powerpilot_warning_action':
            if (args.operation === 'confirm') return requestApi('POST', '/warning/confirm', args.taskId ? { taskId: args.taskId } : {});
            if (args.operation === 'snooze') return requestApi('POST', '/warning/snooze', {
                ...(args.minutes !== undefined ? { minutes: Number(args.minutes) } : { minutes: 10 }),
                ...(args.pin ? { pin: args.pin } : {})
            });
            if (args.operation === 'cancel') return requestApi('POST', '/warning/cancel', args.pin ? { pin: args.pin } : {});
            throw new Error(`Invalid warning operation: ${args.operation}`);
        case 'powerpilot_list_templates':
            return requestApi('GET', args.includeHidden ? '/templates?includeHidden=1' : '/templates');
        case 'powerpilot_save_template':
            return requestApi('POST', '/templates', args);
        case 'powerpilot_delete_template':
            if (!args.id) throw new Error('id is required');
            return requestApi('DELETE', `/templates/${encodeURIComponent(args.id)}`);
        case 'powerpilot_run_template': {
            if (!args.id) throw new Error('id is required');
            const { id, ...rest } = args;
            return requestApi('POST', `/templates/${encodeURIComponent(id)}/run`, rest);
        }
        case 'powerpilot_get_settings':
            return requestApi('GET', '/settings');
        case 'powerpilot_update_settings':
            if (!args.patch || typeof args.patch !== 'object') throw new Error('patch object is required');
            return requestApi('PATCH', '/settings', args.patch);
        case 'powerpilot_update_security_settings':
            if (!args.patch || typeof args.patch !== 'object') throw new Error('patch object is required');
            return requestApi('PATCH', '/settings/security', args.patch);
        case 'powerpilot_security_status':
            return requestApi('GET', '/security/status');
        case 'powerpilot_get_history': {
            const qs = new URLSearchParams();
            if (args.limit !== undefined) qs.set('limit', String(args.limit));
            if (args.action) qs.set('action', String(args.action));
            if (args.resultCode) qs.set('resultCode', String(args.resultCode));
            return requestApi('GET', qs.toString() ? `/history?${qs}` : '/history');
        }
        case 'powerpilot_clear_history':
            return requestApi('DELETE', '/history');
        case 'powerpilot_get_statistics':
            return requestApi('GET', args.days ? `/statistics?days=${encodeURIComponent(args.days)}` : '/statistics');
        case 'powerpilot_get_health':
            return requestApi('GET', '/health');
        case 'powerpilot_wol_list_devices':
            return requestApi('GET', '/wol/devices');
        case 'powerpilot_wol_save_devices':
            return requestApi('PUT', '/wol/devices', { devices: args.devices });
        case 'powerpilot_wol_send':
            return requestApi('POST', '/wol/send', args);
        case 'powerpilot_webhooks_list':
            return requestApi('GET', '/webhooks');
        case 'powerpilot_webhooks_save':
            return requestApi('PUT', '/webhooks', { webhooks: args.webhooks });
        case 'powerpilot_webhook_test':
            return requestApi('POST', '/webhooks/test', args);
        case 'powerpilot_ups_test':
            return requestApi('POST', '/ups/test', args);
        case 'powerpilot_cloud_status':
            return requestApi('GET', '/cloud/status');
        case 'powerpilot_cloud_action': {
            const op = args.operation;
            if (op === 'connect') return requestApi('POST', '/cloud/connect');
            if (op === 'disconnect') return requestApi('POST', '/cloud/disconnect');
            if (op === 'sync') return requestApi('POST', '/cloud/sync', { force: Boolean(args.force) });
            if (op === 'restore') return requestApi('POST', '/cloud/restore', { connect: Boolean(args.connect) });
            if (op === 'set_provider') return requestApi('POST', '/cloud/provider', { providerId: args.providerId });
            if (op === 'set_autosync') return requestApi('PATCH', '/cloud/autosync', { enabled: Boolean(args.enabled) });
            throw new Error(`Invalid cloud operation: ${op}`);
        }
        case 'powerpilot_ai_parse':
            return requestApi('POST', '/ai/parse', args);
        case 'powerpilot_ai_assist':
            return requestApi('POST', '/ai/assist', args);
        case 'powerpilot_ai_diagnose':
            return requestApi('POST', '/ai/diagnose', args);
        case 'powerpilot_docs_search': {
            if (!args.query) throw new Error('query is required');
            const qs = new URLSearchParams({ q: String(args.query) });
            if (args.lang) qs.set('lang', String(args.lang));
            if (args.topK) qs.set('topK', String(args.topK));
            return requestApi('GET', `/docs/search?${qs}`);
        }
        case 'powerpilot_diagnostics':
            if (args.operation === 'snapshot') return requestApi('GET', '/diagnostics');
            if (args.operation === 'clear') return requestApi('DELETE', '/diagnostics');
            if (args.operation === 'create_bundle') return requestApi('POST', '/diagnostics/bundle');
            throw new Error(`Invalid diagnostics operation: ${args.operation}`);
        case 'powerpilot_updates':
            if (args.operation === 'status') return requestApi('GET', '/updates/status');
            if (args.operation === 'check') return requestApi('POST', '/updates/check');
            throw new Error(`Invalid updates operation: ${args.operation}`);
        case 'powerpilot_audit_log': {
            const qs = new URLSearchParams();
            if (args.limit !== undefined) qs.set('limit', String(args.limit));
            if (args.beforeSeq !== undefined) qs.set('beforeSeq', String(args.beforeSeq));
            if (args.verify) qs.set('verify', '1');
            return requestApi('GET', qs.toString() ? `/audit?${qs}` : '/audit');
        }
        case 'powerpilot_audit_verify':
            return requestApi('GET', '/audit/verify');
        case 'powerpilot_inventory':
            return requestApi('GET', '/inventory');
        case 'powerpilot_pending_orders':
            return requestApi('GET', '/orders/pending');
        case 'powerpilot_manage_exemptions':
            if (args.operation === 'list') return requestApi('GET', '/exemptions');
            if (args.operation === 'add') return requestApi('POST', '/exemptions', args.exemption || {});
            if (args.operation === 'delete') {
                if (!args.id) throw new Error('id is required');
                return requestApi('DELETE', `/exemptions/${encodeURIComponent(args.id)}`);
            }
            throw new Error(`Invalid exemptions operation: ${args.operation}`);
        case 'powerpilot_manage_maintenance_windows':
            if (args.operation === 'list') return requestApi('GET', '/maintenance-windows');
            if (args.operation === 'add') return requestApi('POST', '/maintenance-windows', args.window || {});
            if (args.operation === 'delete') {
                if (!args.id) throw new Error('id is required');
                return requestApi('DELETE', `/maintenance-windows/${encodeURIComponent(args.id)}`);
            }
            throw new Error(`Invalid maintenance windows operation: ${args.operation}`);
        case 'powerpilot_reset_template':
            if (!args.id) throw new Error('id is required');
            return requestApi('POST', `/templates/${encodeURIComponent(args.id)}/reset`);
        case 'powerpilot_restore_templates':
            return requestApi('POST', '/templates/restore-defaults', { resetEdits: Boolean(args.resetEdits) });
        case 'powerpilot_submit_order':
            return requestApi('POST', '/orders', args);
        case 'powerpilot_ai_status':
            return requestApi('GET', '/ai/status');
        case 'powerpilot_ai_model':
            if (args.operation === 'download') return requestApi('POST', '/ai/model/download');
            if (args.operation === 'load') return requestApi('POST', '/ai/model/load');
            if (args.operation === 'unload') return requestApi('POST', '/ai/model/unload');
            throw new Error(`Invalid ai_model operation: ${args.operation}`);
        case 'powerpilot_ai_insights':
            if (args.operation === 'energy') return requestApi('GET', args.lang ? `/ai/energy?lang=${encodeURIComponent(args.lang)}` : '/ai/energy');
            if (args.operation === 'suggest') return requestApi('GET', args.lang ? `/ai/suggest?lang=${encodeURIComponent(args.lang)}` : '/ai/suggest');
            if (args.operation === 'dismiss') {
                if (!args.topic) throw new Error('topic is required');
                return requestApi('POST', '/ai/dismiss-suggestion', { topic: args.topic });
            }
            throw new Error(`Invalid ai_insights operation: ${args.operation}`);
        case 'powerpilot_device_estimate':
            return requestApi('POST', '/device/estimate', { apply: Boolean(args.apply) });
        case 'powerpilot_console_sync':
            return requestApi('POST', '/console/sync');
        case 'powerpilot_updates_manage':
            if (args.operation === 'download') return requestApi('POST', '/updates/download');
            if (args.operation === 'install_on_quit') return requestApi('PATCH', '/updates/install-on-quit', { enabled: Boolean(args.enabled) });
            if (args.operation === 'install_now') return requestApi('POST', '/updates/install', args.pin ? { pin: args.pin } : {});
            throw new Error(`Invalid updates_manage operation: ${args.operation}`);
        case 'powerpilot_cloud_folder':
            if (args.operation === 'set') {
                if (!args.dirPath) throw new Error('dirPath is required');
                return requestApi('PUT', '/cloud/folder', { dirPath: args.dirPath });
            }
            if (args.operation === 'reset') return requestApi('POST', '/cloud/folder/reset');
            if (args.operation === 'dismiss_recovery') return requestApi('POST', '/cloud/dismiss-recovery');
            throw new Error(`Invalid cloud_folder operation: ${args.operation}`);
        case 'powerpilot_export_data':
            if (args.target === 'settings') return requestApi('GET', '/export/settings');
            if (args.target === 'templates') return requestApi('GET', '/export/templates');
            throw new Error(`Invalid export target: ${args.target}`);
        case 'powerpilot_import_data':
            if (args.target === 'settings') return requestApi('POST', '/import/settings', args.payload || {});
            if (args.target === 'templates') return requestApi('POST', '/import/templates', args.payload || {});
            throw new Error(`Invalid import target: ${args.target}`);
        case 'powerpilot_cancel_pin':
            if (args.operation === 'status') return requestApi('GET', '/security/cancel-pin');
            if (args.operation === 'set') return requestApi('PUT', '/security/cancel-pin', {
                pin: args.pin,
                ...(args.currentPin ? { currentPin: args.currentPin } : {})
            });
            if (args.operation === 'clear') return requestApi('DELETE', '/security/cancel-pin', {
                ...(args.currentPin ? { currentPin: args.currentPin } : (args.pin ? { currentPin: args.pin } : {}))
            });
            throw new Error(`Invalid cancel_pin operation: ${args.operation}`);
        case 'powerpilot_rotate_api_key':
            return requestApi('POST', '/security/rotate-key', {
                ...(args.role ? { role: args.role } : {}),
                ...(typeof args.saveProfile === 'boolean' ? { saveProfile: args.saveProfile } : {})
            });
        default:
            return null;
    }
}

module.exports = {
    TOOLS,
    RESOURCES,
    RESOURCE_PATHS,
    executeToolCall
};
