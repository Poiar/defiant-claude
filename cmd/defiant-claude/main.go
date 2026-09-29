// defiant-claude — provider-agnostic Claude Code proxy (Go rewrite).
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/Poiar/defiant-claude/internal/config"
	"github.com/Poiar/defiant-claude/internal/crypto"
	"github.com/Poiar/defiant-claude/internal/proxy"
	"github.com/Poiar/defiant-claude/internal/routing"
)

const version = "0.1.0"

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		printUsage(os.Stderr)
		os.Exit(2)
	}
	switch args[0] {
	case "--version", "-v", "version":
		fmt.Printf("defiant-claude %s\n", version)
	case "--help", "-h", "help":
		printUsage(os.Stdout)
	case "--lint-config", "lint-config":
		os.Exit(runLint())
	case "--encrypt-key", "encrypt-key":
		os.Exit(runEncryptKey())
	case "--dry-run", "dry-run":
		os.Exit(runDryRun(args[1:]))
	case "launch", "run":
		os.Exit(runLaunch(args[1:]))
	default:
		os.Exit(runDryRun(args))
	}
}

func printUsage(w *os.File) {
	fmt.Fprint(w, `defiant-claude — provider-agnostic Claude Code proxy

Usage:
  defiant-claude [spec...]          resolve model specs to providers (dry-run)
  defiant-claude -b <backend> ...   use a named config
  defiant-claude --dry-run          show the full routing table
  defiant-claude --lint-config      validate providers.json
  defiant-claude launch             start the proxy (prints PORT:<n>)
  defiant-claude --version          print version
  defiant-claude --help             show this help
`)
}

func loadConfig() (*config.Config, error) {
	dir, err := config.DefaultConfigDir()
	if err != nil {
		return nil, err
	}
	return config.LoadUser(dir)
}

// slotOverrides loads ~/.defiant-claude/slot-overrides.json (non-fatal).
func slotOverrides() map[string]string {
	dir, err := config.DefaultConfigDir()
	if err != nil {
		return nil
	}
	o, err := config.LoadSlotOverrides(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: %v\n", err)
		return nil
	}
	return o
}

func runEncryptKey() int {
	master := os.Getenv("DEFIANT_CLAUDE_ENCRYPTION_KEY")
	if master == "" {
		fmt.Fprintln(os.Stderr, "error: DEFIANT_CLAUDE_ENCRYPTION_KEY is not set")
		return 1
	}
	key, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	encrypted, err := crypto.Encrypt(strings.TrimSpace(string(key)), master)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Println(encrypted)
	return 0
}

func runLint() int {
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	problems := cfg.Lint()
	if len(problems) == 0 {
		fmt.Printf("config OK: %d providers, %d named configs, %d aliases, %d models priced\n",
			len(cfg.Providers), len(cfg.Configs), len(cfg.Aliases), len(cfg.Pricing))
		return 0
	}
	fmt.Printf("%d problem(s):\n", len(problems))
	for _, p := range problems {
		fmt.Printf("  - %s\n", p)
	}
	return 1
}

func runDryRun(args []string) int {
	backend := "ds"
	specs := args
	if len(args) >= 2 && args[0] == "-b" {
		backend = args[1]
		specs = args[2:]
	}

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}

	if len(specs) > 0 {
		r := routing.NewResolver(cfg, backend)
		r.SetOverrides(slotOverrides())
		fmt.Printf("resolving against backend %q:\n", backend)
		for _, spec := range specs {
			t, err := r.Resolve(spec)
			if err != nil {
				fmt.Printf("  %-28s -> ERROR: %v\n", spec, err)
				continue
			}
			line := fmt.Sprintf("  %-28s -> %s:%s", spec, t.ProviderKey, t.Model)
			for _, fb := range r.FallbackTargets(t) {
				line += fmt.Sprintf("  ->  %s:%s", fb.ProviderKey, fb.Model)
			}
			line += fmt.Sprintf("  (format=%s)", t.WireFormat)
			fmt.Println(line)
		}
		return 0
	}

	fmt.Printf("providers: %d | named configs: %d | aliases: %d\n\n", len(cfg.Providers), len(cfg.Configs), len(cfg.Aliases))
	fmt.Println("Named configs (slot → provider:model):")
	names := make([]string, 0, len(cfg.Configs))
	for n := range cfg.Configs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		sc := cfg.Configs[n]
		fmt.Printf("  %-8s %s\n", n, sc.Name)
		fmt.Printf("           opus   = %s\n", sc.Opus)
		fmt.Printf("           sonnet = %s\n", sc.Sonnet)
		fmt.Printf("           haiku  = %s\n", sc.Haiku)
		fmt.Printf("           sub    = %s\n", sc.Sub)
		fmt.Printf("           fable  = %s\n", sc.Fable)
	}
	return 0
}

func runLaunch(args []string) int {
	fs := flag.NewFlagSet("launch", flag.ExitOnError)
	backend := fs.String("b", "ds", "named config to use")
	port := fs.Int("port", 0, "port to listen on (0 = ephemeral)")
	noSpawn := fs.Bool("no-spawn", false, "start the proxy only; don't spawn Claude Code")
	fs.Parse(args)

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}

	srv := proxy.New(cfg, *backend)
	srv.SetSlotOverrides(slotOverrides())
	if dir, err := config.DefaultConfigDir(); err == nil {
		stop := srv.WatchConfig(dir, 3*time.Second)
		defer stop()
	}
	ln, err := srv.Listen(*port)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	actual := ln.Addr().(*net.TCPAddr).Port

	if *noSpawn {
		fmt.Printf("PORT:%d\n", actual)
		if err := http.Serve(ln, srv); err != nil {
			fmt.Fprintf(os.Stderr, "serve: %v\n", err)
			return 1
		}
		return 0
	}

	sc, ok := cfg.Configs[*backend]
	if !ok {
		fmt.Fprintf(os.Stderr, "error: unknown backend %q\n", *backend)
		return 1
	}

	// Start the proxy in the background and spawn Claude Code against it.
	go func() {
		if err := http.Serve(ln, srv); err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		}
	}()

	if err := spawnClaude(buildClaudeEnv(sc, cfg.ContextLimits, actual)); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			fmt.Printf("PORT:%d\n", actual)
			fmt.Fprintf(os.Stderr, "claude not found — proxy is running; set ANTHROPIC_BASE_URL=http://127.0.0.1:%d\n", actual)
			select {} // keep the proxy alive
		}
		fmt.Fprintf(os.Stderr, "claude: %v\n", err)
		return 1
	}
	return 0
}
