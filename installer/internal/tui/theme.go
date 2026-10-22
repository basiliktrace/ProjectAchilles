package tui

import (
	"image/color"
	"strings"

	"charm.land/huh/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/projectachilles/ProjectAchilles/installer/internal/sysprobe"
)

// theme holds the wizard's styles. There is one accent colour (the f0
// green, darkened on light backgrounds); status colours come from the
// terminal's own ANSI palette so they track its light/dark scheme, and every
// status also carries a glyph and a word so nothing relies on colour alone.
type theme struct {
	dark bool

	accent  color.Color
	Brand   lipgloss.Style // header product name
	Title   lipgloss.Style // header screen title / section headings
	Muted   lipgloss.Style // secondary text
	Strong  lipgloss.Style
	Code    lipgloss.Style // commands and record text the admin copies
	Rule    lipgloss.Style
	Pass    lipgloss.Style
	Warn    lipgloss.Style
	Fail    lipgloss.Style
	KeyHint lipgloss.Style
}

// accentFor is the f0 green: bright on dark backgrounds, darkened for
// contrast on light ones.
func accentFor(dark bool) color.Color {
	return lipgloss.LightDark(dark)(lipgloss.Color("#0B7A3E"), lipgloss.Color("#3EF08A"))
}

func newTheme(dark bool) theme {
	accent := accentFor(dark)
	return theme{
		dark:    dark,
		accent:  accent,
		Brand:   lipgloss.NewStyle().Bold(true).Foreground(accent),
		Title:   lipgloss.NewStyle().Bold(true),
		Muted:   lipgloss.NewStyle().Faint(true),
		Strong:  lipgloss.NewStyle().Bold(true),
		Code:    lipgloss.NewStyle().Foreground(accent),
		Rule:    lipgloss.NewStyle().Faint(true),
		Pass:    lipgloss.NewStyle().Foreground(lipgloss.Green).Bold(true),
		Warn:    lipgloss.NewStyle().Foreground(lipgloss.Yellow).Bold(true),
		Fail:    lipgloss.NewStyle().Foreground(lipgloss.Red).Bold(true),
		KeyHint: lipgloss.NewStyle().Bold(true),
	}
}

// Status glyphs: a symbol plus a word, fixed width.
const (
	glyphPass = "✓ PASS"
	glyphWarn = "! WARN"
	glyphFail = "✗ FAIL"
)

func (t theme) status(s sysprobe.Status) string {
	switch s {
	case sysprobe.Pass:
		return t.Pass.Render(glyphPass)
	case sysprobe.Warn:
		return t.Warn.Render(glyphWarn)
	default:
		return t.Fail.Render(glyphFail)
	}
}

// Inline notices for screen bodies. msg is pre-wrapped to the body width
// minus 2; continuation lines are indented under the text.
func (t theme) ok(msg string) string   { return t.Pass.Render("✓") + " " + hang(msg) }
func (t theme) warn(msg string) string { return t.Warn.Render("!") + " " + hang(msg) }
func (t theme) bad(msg string) string  { return t.Fail.Render("✗") + " " + hang(msg) }

func hang(s string) string { return strings.ReplaceAll(s, "\n", "\n  ") }

// huhTheme adapts Huh's base theme to the accent colour. Huh re-evaluates
// it when the terminal reports its background, so forms built before that
// reply still end up with the right shade.
func (t theme) huhTheme() huh.Theme {
	return huh.ThemeFunc(func(isDark bool) *huh.Styles {
		accent := accentFor(isDark)
		s := huh.ThemeBase(isDark)
		s.Focused.Base = s.Focused.Base.BorderForeground(accent)
		s.Focused.Title = s.Focused.Title.Bold(true)
		s.Focused.NoteTitle = s.Focused.NoteTitle.Bold(true)
		s.Focused.Description = s.Focused.Description.Faint(true)
		s.Focused.SelectSelector = lipgloss.NewStyle().Foreground(accent).SetString("> ")
		s.Focused.SelectedOption = s.Focused.SelectedOption.Foreground(accent)
		s.Focused.ErrorIndicator = lipgloss.NewStyle().Foreground(lipgloss.Red).SetString(" ✗")
		s.Focused.ErrorMessage = lipgloss.NewStyle().Foreground(lipgloss.Red).SetString("✗")
		s.Focused.FocusedButton = s.Focused.FocusedButton.Background(accent).Foreground(lipgloss.Black).Bold(true)
		s.Focused.TextInput.Cursor = s.Focused.TextInput.Cursor.Foreground(accent)
		s.Focused.TextInput.Prompt = s.Focused.TextInput.Prompt.Foreground(accent)
		s.Blurred = s.Focused
		s.Blurred.Base = s.Blurred.Base.BorderStyle(lipgloss.HiddenBorder())
		s.Blurred.SelectSelector = lipgloss.NewStyle().SetString("  ")
		s.Blurred.Title = s.Blurred.Title.Bold(false)
		return s
	})
}

// wrap word-wraps s to width, preserving existing line breaks.
func wrap(s string, width int) string {
	if width < 10 {
		width = 10
	}
	return ansi.Wordwrap(s, width, "")
}

// indent prefixes every line of s.
func indent(s, prefix string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		if l != "" {
			lines[i] = prefix + l
		}
	}
	return strings.Join(lines, "\n")
}
