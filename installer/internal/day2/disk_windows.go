//go:build windows

package day2

import "errors"

func diskFree(string) (uint64, error) { return 0, errors.New("not supported on windows") }
