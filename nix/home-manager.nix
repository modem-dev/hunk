{
  config,
  lib,
  pkgs,
  ...
}:
with lib;
let
  cfg = config.programs.hunk;
  tomlFormat = pkgs.formats.toml { };
in
{
  options.programs.hunk = {
    enable = mkEnableOption "hunk, a terminal-first diff viewer";

    package = mkOption {
      type = types.package;
      default = pkgs.hunk;
      defaultText = literalExpression "pkgs.hunk";
      description = "The hunk package to use.";
    };

    settings = mkOption {
      type = tomlFormat.type;
      default = { };
      example = literalExpression ''
        {
          theme = "graphite";
          mode = "auto";
          line_numbers = true;
          exclude_untracked = false;
        }
      '';
      description = ''
        Configuration for hunk, see
        <link xlink:href="https://github.com/modem-dev/hunk#config"/>.
      '';
    };

    enableGitIntegration = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to set hunk as the default git pager.";
    };

    enableJujutsuIntegration = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to set hunk as the default jujutsu pager. Also sets ui.diff-formatter to \":git\" so jj emits git-style diffs hunk can render.";
    };

    enableClaudeIntegration = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to link the hunk-review skill under ~/.claude/skills.";
    };
  };

  config = mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."hunk/config.toml" = mkIf (cfg.settings != { }) {
      source = tomlFormat.generate "hunk-config.toml" cfg.settings;
    };

    programs.git.settings.core.pager = mkIf cfg.enableGitIntegration "hunk pager";

    programs.jujutsu.settings = mkIf cfg.enableJujutsuIntegration {
      ui = {
        diff-formatter = ":git";
        pager = "hunk pager";
      };
    };

    home.file = mkIf cfg.enableClaudeIntegration {
      ".claude/skills/hunk-review".source = "${cfg.package}/skills/hunk-review";
    };
  };
}
