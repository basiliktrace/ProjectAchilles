VERSION ?= dev
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: test vet build
test:
	go test ./...
vet:
	go vet ./...
build:
	mkdir -p dist
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/achilles-installer-linux-amd64 .
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/achilles-installer-linux-arm64 .
