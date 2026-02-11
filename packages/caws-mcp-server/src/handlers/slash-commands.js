/**
 * Slash Commands & Specs CRUD Handler Module
 *
 * Handles slash command routing and specs management (list, create, show, update, delete).
 *
 * Extracted from index.js to reduce god object size.
 */

/**
 * Install slash command handlers on a CawsMcpServer instance.
 * @param {object} server - CawsMcpServer instance
 */
export function installSlashCommandHandlers(server) {
  server.handleSlashCommands = async function (args) {
    const { command, ...params } = args;

    const slashCommandMap = {
      '/caws:start': 'caws_init',
      '/caws:init': 'caws_init',
      '/caws:validate': 'caws_validate',
      '/caws:archive': 'caws_archive',
      '/caws:status': 'caws_status',
      '/caws:specs': 'caws_slash_commands',
      '/caws:evaluate': 'caws_evaluate',
      '/caws:iterate': 'caws_iterate',
      '/caws:diagnose': 'caws_diagnose',
      '/caws:scaffold': 'caws_scaffold',
      '/caws:help': 'caws_help',
      '/caws:waivers': 'caws_waivers_list',
      '/caws:workflow': 'caws_workflow_guidance',
      '/caws:monitor': 'caws_monitor_status',
      '/caws:provenance': 'caws_provenance',
      '/caws:hooks': 'caws_hooks',
      '/caws:quality-gates': 'caws_quality_gates',
      '/caws:quality-gates-run': 'caws_quality_gates_run',
      '/caws:quality-gates-status': 'caws_quality_gates_status',
      '/caws:quality-exceptions-list': 'caws_quality_exceptions_list',
      '/caws:quality-exceptions-create': 'caws_quality_exceptions_create',
      '/caws:refactor-progress': 'caws_refactor_progress_check',
    };

    const mappedTool = slashCommandMap[command];

    if (!mappedTool) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: `Unknown slash command: ${command}`,
                availableCommands: Object.keys(slashCommandMap),
                suggestion: 'Use /caws:help for available commands',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    if (mappedTool === 'caws_slash_commands') {
      return await this.handleSlashCommandsWithSubcommands(args);
    }

    try {
      const toolArgs = { ...params, workingDirectory: params.workingDirectory || process.cwd() };

      switch (mappedTool) {
        case 'caws_init':
          return await this.handleCawsInit(toolArgs);
        case 'caws_scaffold':
          return await this.handleCawsScaffold(toolArgs);
        case 'caws_evaluate':
          return await this.handleCawsEvaluate(toolArgs);
        case 'caws_iterate':
          return await this.handleCawsIterate(toolArgs);
        case 'caws_validate':
          return await this.handleCawsValidate(toolArgs);
        case 'caws_archive':
          return await this.handleCawsArchive(toolArgs);
        case 'caws_workflow_guidance':
          return await this.handleWorkflowGuidance(toolArgs);
        case 'caws_quality_monitor':
          return await this.handleQualityMonitor(toolArgs);
        case 'caws_test_analysis':
          return await this.handleTestAnalysis(toolArgs);
        case 'caws_provenance':
          return await this.handleProvenance(toolArgs);
        case 'caws_hooks':
          return await this.handleHooks(toolArgs);
        case 'caws_status':
          return await this.handleStatus(toolArgs);
        case 'caws_diagnose':
          return await this.handleDiagnose(toolArgs);
        case 'caws_help':
          return await this.handleHelp(toolArgs);
        default:
          throw new Error(`Tool handler not implemented: ${mappedTool}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: false, error: error.message, slashCommand: command, mappedTool },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  };

  server.handleSlashCommandsWithSubcommands = async function (args) {
    const { command, ...params } = args;

    if (command.startsWith('/caws:specs ')) {
      const subcommand = command.replace('/caws:specs ', '');

      const fs = await import('fs-extra');
      const path = await import('path');
      const yaml = await import('js-yaml');

      const SPECS_DIR = '.caws/specs';
      const SPECS_REGISTRY = '.caws/specs/registry.json';

      try {
        let registry = { specs: {} };
        if (fs.existsSync(SPECS_REGISTRY)) {
          registry = JSON.parse(fs.readFileSync(SPECS_REGISTRY, 'utf8'));
        }

        // List specs
        if (subcommand === 'list' || subcommand === '') {
          if (!fs.existsSync(SPECS_DIR)) {
            return {
              content: [
                { type: 'text', text: JSON.stringify({ specs: [], count: 0 }, null, 2) },
              ],
            };
          }

          const files = fs.readdirSync(SPECS_DIR, { recursive: true });
          const yamlFiles = files.filter(
            (file) => file.endsWith('.yaml') || file.endsWith('.yml')
          );

          const specs = [];
          for (const file of yamlFiles) {
            const filePath = path.join(SPECS_DIR, file);
            try {
              const content = fs.readFileSync(filePath, 'utf8');
              const spec = yaml.load(content);
              specs.push({
                id: spec.id || path.basename(file, path.extname(file)),
                type: spec.type || 'feature',
                status: spec.status || 'draft',
                title: spec.title || 'Untitled',
              });
            } catch {
              // Skip invalid files
            }
          }

          return {
            content: [
              { type: 'text', text: JSON.stringify({ specs, count: specs.length }, null, 2) },
            ],
          };
        }

        // Create spec
        if (subcommand.startsWith('create ')) {
          const specId = subcommand.replace('create ', '');
          const { type = 'feature', title, tier = 'T3', mode = 'development' } = params;

          const specContent = {
            id: specId,
            type,
            title: title || `New ${type}`,
            status: 'draft',
            risk_tier: tier,
            mode,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            acceptance_criteria: [],
          };

          fs.ensureDirSync(SPECS_DIR);
          const filePath = path.join(SPECS_DIR, `${specId}.yaml`);
          fs.writeFileSync(filePath, yaml.dump(specContent, { indent: 2 }));

          registry.specs[specId] = {
            path: `${specId}.yaml`,
            type,
            status: 'draft',
            created_at: specContent.created_at,
            updated_at: specContent.updated_at,
          };
          fs.writeFileSync(SPECS_REGISTRY, JSON.stringify(registry, null, 2));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    spec: { id: specId, type, title: specContent.title, status: 'draft' },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Show spec
        if (subcommand.startsWith('show ')) {
          const specId = subcommand.replace('show ', '');

          if (!registry.specs[specId]) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Spec '${specId}' not found` }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const specPath = path.join(SPECS_DIR, registry.specs[specId].path);
          const content = fs.readFileSync(specPath, 'utf8');
          const spec = yaml.load(content);

          return {
            content: [{ type: 'text', text: JSON.stringify(spec, null, 2) }],
          };
        }

        // Update spec
        if (subcommand.startsWith('update ')) {
          const specId = subcommand.replace('update ', '');

          if (!registry.specs[specId]) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Spec '${specId}' not found` }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const specPath = path.join(SPECS_DIR, registry.specs[specId].path);
          const content = fs.readFileSync(specPath, 'utf8');
          const spec = yaml.load(content);

          const updates = {};
          if (params.status) updates.status = params.status;
          if (params.title) updates.title = params.title;
          if (params.description) updates.description = params.description;

          const updatedSpec = { ...spec, ...updates, updated_at: new Date().toISOString() };
          fs.writeFileSync(specPath, yaml.dump(updatedSpec, { indent: 2 }));

          registry.specs[specId].updated_at = updatedSpec.updated_at;
          if (params.status) registry.specs[specId].status = params.status;
          fs.writeFileSync(SPECS_REGISTRY, JSON.stringify(registry, null, 2));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, spec: { id: specId, updates } }, null, 2),
              },
            ],
          };
        }

        // Delete spec
        if (subcommand.startsWith('delete ')) {
          const specId = subcommand.replace('delete ', '');

          if (!registry.specs[specId]) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Spec '${specId}' not found` }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const specPath = path.join(SPECS_DIR, registry.specs[specId].path);
          fs.removeSync(specPath);
          delete registry.specs[specId];
          fs.writeFileSync(SPECS_REGISTRY, JSON.stringify(registry, null, 2));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { success: true, spec: specId, message: 'Spec deleted successfully' },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: `Unsupported slash command: ${command}`,
              supported: [
                '/caws:specs list',
                '/caws:specs create',
                '/caws:specs show',
                '/caws:specs update',
                '/caws:specs delete',
              ],
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  };
}
