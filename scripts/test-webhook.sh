#!/bin/bash

# Test webhook endpoint with sample GitLab events

set -e

SERVICE_URL="${SERVICE_URL:-http://localhost:3000}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-test-secret}"

# Function to generate signature
generate_signature() {
    local payload="$1"
    echo -n "$payload" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.*= /sha256=/'
}

# Sample issue event
issue_payload='{
  "object_kind": "issue",
  "event_type": "issue",
  "user": {
    "id": 1,
    "name": "Test User",
    "username": "testuser",
    "email": "test@example.com"
  },
  "project": {
    "id": 123,
    "name": "test-project",
    "web_url": "https://gitlab.com/test/project",
    "default_branch": "main",
    "http_url_to_repo": "https://gitlab.com/test/project.git"
  },
  "object_attributes": {
    "id": 456,
    "title": "Test Issue",
    "description": "@claude Please help me fix the authentication bug in src/auth.js",
    "state": "opened",
    "iid": 1,
    "url": "https://gitlab.com/test/project/-/issues/1"
  },
  "issue": {
    "id": 456,
    "iid": 1,
    "title": "Test Issue",
    "description": "@claude Please help me fix the authentication bug in src/auth.js",
    "state": "opened",
    "web_url": "https://gitlab.com/test/project/-/issues/1",
    "author": {
      "id": 1,
      "name": "Test User",
      "username": "testuser",
      "email": "test@example.com"
    }
  }
}'

echo "🧪 Testing GitLab webhook endpoints..."

# Test issue webhook
echo "Testing issue webhook..."
signature=$(generate_signature "$issue_payload")

response=$(curl -s -w "%{http_code}" -o /tmp/webhook_response \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-GitLab-Token: $signature" \
  -d "$issue_payload" \
  "$SERVICE_URL/webhook")

if [ "$response" = "200" ]; then
    echo "✅ Issue webhook test passed"
    cat /tmp/webhook_response
else
    echo "❌ Issue webhook test failed (HTTP $response)"
    cat /tmp/webhook_response
    exit 1
fi

# Test merge request event
mr_payload='{
  "object_kind": "merge_request",
  "event_type": "merge_request",
  "user": {
    "id": 1,
    "name": "Test User",
    "username": "testuser",
    "email": "test@example.com"
  },
  "project": {
    "id": 123,
    "name": "test-project",
    "web_url": "https://gitlab.com/test/project",
    "default_branch": "main",
    "http_url_to_repo": "https://gitlab.com/test/project.git"
  },
  "object_attributes": {
    "id": 789,
    "iid": 1,
    "title": "Test MR",
    "description": "@claude Please review this code and suggest improvements",
    "state": "opened",
    "source_branch": "feature/test",
    "target_branch": "main",
    "url": "https://gitlab.com/test/project/-/merge_requests/1"
  },
  "merge_request": {
    "id": 789,
    "iid": 1,
    "title": "Test MR",
    "description": "@claude Please review this code and suggest improvements",
    "state": "opened",
    "source_branch": "feature/test",
    "target_branch": "main",
    "web_url": "https://gitlab.com/test/project/-/merge_requests/1",
    "author": {
      "id": 1,
      "name": "Test User",
      "username": "testuser",
      "email": "test@example.com"
    }
  }
}'

echo "Testing merge request webhook..."
signature=$(generate_signature "$mr_payload")

response=$(curl -s -w "%{http_code}" -o /tmp/webhook_response \
  -X POST \
  -H "Content-Type: application/json" \
  -H "X-GitLab-Token: $signature" \
  -d "$mr_payload" \
  "$SERVICE_URL/webhook")

if [ "$response" = "200" ]; then
    echo "✅ Merge request webhook test passed"
    cat /tmp/webhook_response
else
    echo "❌ Merge request webhook test failed (HTTP $response)"
    cat /tmp/webhook_response
    exit 1
fi

echo "🎉 All webhook tests passed!"