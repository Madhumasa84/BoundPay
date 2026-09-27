package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"
)

func TestCanonicalJCSAndSaltedCommitment(t *testing.T) {
	payload := scopeTerms{
		SchemaVersion:      1,
		PolicyVersion:      7,
		AllowedMerchantIDs: []string{"demo_store"},
		AllowedCategories:  []string{"books"},
	}
	canonical, err := canonicalJSON(payload)
	if err != nil {
		t.Fatal(err)
	}
	wantCanonical := `{"allowedCategories":["books"],"allowedMerchantIds":["demo_store"],"policyVersion":7,"schemaVersion":1}`
	if string(canonical) != wantCanonical {
		t.Fatalf("canonical JSON mismatch\n got: %s\nwant: %s", canonical, wantCanonical)
	}

	salt := make([]byte, 32)
	for i := range salt {
		salt[i] = byte(i)
	}
	preimage := append([]byte("boundpay:commit:v1:passport-scope\x00"), salt...)
	preimage = append(preimage, []byte(wantCanonical)...)
	want := sha256.Sum256(preimage)
	if got := commitment("passport-scope", salt, payload); got != hex.EncodeToString(want[:]) {
		t.Fatalf("commitment mismatch: got %s want %x", got, want)
	}
	if got := commitment("passport-scope", salt, payload); got != "69c751b8168ab999c26bc025ca3432ed419d62742a7bcc5b9f2f9e799c862f57" {
		t.Fatalf("commitment differs from the TypeScript JCS fixture: %s", got)
	}
	otherSalt := append([]byte(nil), salt...)
	otherSalt[0] ^= 1
	if commitment("passport-scope", otherSalt, payload) == hex.EncodeToString(want[:]) {
		t.Fatal("changing a commitment salt did not change the digest")
	}
}

func TestSharedAllowanceRejectsOverspendAndInvalidCounters(t *testing.T) {
	mandate := Mandate{AggregateCapPaise: 500000, ReservedPaise: 200000, SettledPaise: 100000}
	if !hasSharedAllowance(mandate, 200000) {
		t.Fatal("exact remaining allowance should be available")
	}
	if hasSharedAllowance(mandate, 200001) {
		t.Fatal("reservation above remaining allowance must fail")
	}
	if hasSharedAllowance(mandate, 0) || hasSharedAllowance(mandate, -1) {
		t.Fatal("non-positive amount must fail")
	}
	mandate.ReservedPaise = -1
	if hasSharedAllowance(mandate, 1) {
		t.Fatal("negative reserved counter must fail closed")
	}
	mandate.ReservedPaise = 400000
	if hasSharedAllowance(mandate, 1) {
		t.Fatal("inconsistent aggregate counters must fail closed")
	}
}

func TestOnePassportCannotOpenMultipleSharedAllowances(t *testing.T) {
	existing, err := json.Marshal(passportMandateLink{MandateID: "shared-mandate-1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := checkPassportMandateBinding(nil, "shared-mandate-1"); err != nil {
		t.Fatalf("new Passport binding should be allowed: %v", err)
	}
	if err := checkPassportMandateBinding(existing, "shared-mandate-1"); err != nil {
		t.Fatalf("idempotent issuance of the same mandate should be allowed: %v", err)
	}
	if err := checkPassportMandateBinding(existing, "shared-mandate-2"); err == nil {
		t.Fatal("a second mandate must not reuse the Passport's full cumulative allowance")
	}
	if err := checkPassportMandateBinding([]byte(`{}garbage`), "shared-mandate-1"); err == nil {
		t.Fatal("a malformed Passport binding must fail closed")
	}
}

func TestExecutorAndVerifierPermissionsAreIdentityScoped(t *testing.T) {
	mandate := Mandate{
		OwnerMSP: "OwnerMSP", OwnerIdentity: "owner-cert",
		ParticipantMSPs: []string{"Org1MSP", "Org2MSP"},
		ParticipantIdentities: []callerIdentity{
			{MSPID: "Org1MSP", ClientID: "x509::CN=service-a"},
			{MSPID: "Org2MSP", ClientID: "x509::CN=service-b"},
		},
		VerifierIdentities: []callerIdentity{{MSPID: "VerifierMSP", ClientID: "x509::CN=payment-verifier"}},
	}
	reservation := Reservation{Status: reserved, ParticipantMSP: "Org1MSP", ExecutorIdentity: "x509::CN=service-a"}
	if !isMandateOwner(mandate, "OwnerMSP", "owner-cert") || isMandateOwner(mandate, "OwnerMSP", "other-cert") {
		t.Fatal("mandate owner must match exact certificate identity")
	}
	if !canClaimDispatch(mandate, reservation, "Org1MSP", "x509::CN=service-a") {
		t.Fatal("reservation executor should be able to claim once")
	}
	if isParticipant(mandate, "Org1MSP", "x509::CN=unlisted-admin") {
		t.Fatal("another certificate in an authorized MSP must not become a spending participant")
	}
	if canClaimDispatch(mandate, reservation, "Org1MSP", "x509::CN=other-service") {
		t.Fatal("another identity in the same MSP must not claim dispatch")
	}
	reservation.Status = dispatching
	if canClaimDispatch(mandate, reservation, "Org1MSP", "x509::CN=service-a") {
		t.Fatal("dispatch claim must be one-time")
	}
	if canCommitOutcome(mandate, reservation, "Org1MSP", "x509::CN=service-a") {
		t.Fatal("participant executor is not the configured verifier")
	}
	if canCommitOutcome(mandate, reservation, "VerifierMSP", "x509::CN=other-verifier") {
		t.Fatal("unlisted verifier certificate must not confirm outcomes")
	}
	if !canCommitOutcome(mandate, reservation, "VerifierMSP", "x509::CN=payment-verifier") {
		t.Fatal("configured verifier identity should confirm a dispatched outcome")
	}
	if canReleaseReservation(mandate, reservation, "Org1MSP", "x509::CN=service-a") {
		t.Fatal("possibly dispatched payment requires verifier release")
	}
	if !canReleaseReservation(mandate, reservation, "VerifierMSP", "x509::CN=payment-verifier") {
		t.Fatal("verifier should be able to release after definitive reconciliation")
	}
}

func TestParticipantIdentityListUsesExactAuthenticatedSubjects(t *testing.T) {
	participants, err := parseIdentities(`[{"mspId":"Org2MSP","clientId":"cert-b"},{"mspId":"Org1MSP","clientId":"cert-a"}]`)
	if err != nil {
		t.Fatal(err)
	}
	mandate := Mandate{ParticipantIdentities: participants, ParticipantMSPs: identityMSPs(participants)}
	if !isParticipant(mandate, "Org1MSP", "cert-a") || !isParticipant(mandate, "Org2MSP", "cert-b") {
		t.Fatal("listed exact participant certificate identities should be authorized")
	}
	if isParticipant(mandate, "Org1MSP", "cert-not-listed") || isParticipant(mandate, "Org3MSP", "cert-b") {
		t.Fatal("unlisted exact identity or incorrect MSP must not be authorized")
	}
}

func TestUndispatchedReleaseAndReservationIdempotencyBinding(t *testing.T) {
	mandate := Mandate{VerifierIdentities: []callerIdentity{{MSPID: "VerifierMSP", ClientID: "verifier"}}}
	reservation := Reservation{
		MandateID: "mandate-1", ReservationID: "reserve-1", RequestID: "request-1", PaymentAttemptID: "attempt-1",
		PassportID: "pass-1", PassportDigest: fmt.Sprintf("%064x", 1), ParticipantMSP: "Org1MSP", ExecutorIdentity: "service-a",
		AmountPaise: 300000, Currency: "INR", ScopeCommitment: fmt.Sprintf("%064x", 2), RequestCommitment: fmt.Sprintf("%064x", 3), Status: reserved,
	}
	if !canReleaseReservation(mandate, reservation, "Org1MSP", "service-a") {
		t.Fatal("executor may release an undispatched reservation")
	}
	if canReleaseReservation(mandate, reservation, "Org1MSP", "other-service") {
		t.Fatal("another participant identity may not release this reservation")
	}
	candidate := reservation
	if !sameReservationRequest(reservation, candidate) {
		t.Fatal("identical retry should match the existing reservation")
	}
	candidate.AmountPaise++
	if sameReservationRequest(reservation, candidate) {
		t.Fatal("changed amount under the same reservation ID must be rejected")
	}
	candidate = reservation
	candidate.ExecutorIdentity = "other-service"
	if sameReservationRequest(reservation, candidate) {
		t.Fatal("changed executor under the same reservation ID must be rejected")
	}
}

func TestParseVerifierIdentitiesRequiresUniqueExactSubjects(t *testing.T) {
	values, err := parseIdentities(`[{"mspId":"Org2MSP","clientId":"cert-b"},{"mspId":"Org1MSP","clientId":"cert-a"}]`)
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 2 || values[0].MSPID != "Org1MSP" {
		t.Fatalf("verifier identities were not normalized deterministically: %+v", values)
	}
	if _, err := parseIdentities(`[{"mspId":"Org1MSP","clientId":"cert-a"},{"mspId":"Org1MSP","clientId":"cert-a"}]`); err == nil {
		t.Fatal("duplicate verifier identity must be rejected")
	}
}

func TestRequestIndexValueIsValidJsonForDrunixStateDatabase(t *testing.T) {
	encoded, err := encodeRequestIndex("reservation-1")
	if err != nil {
		t.Fatalf("encode request index: %v", err)
	}
	if !json.Valid(encoded) {
		t.Fatalf("Drunix state value must be JSON, got %q", encoded)
	}
	decoded, err := decodeRequestIndex(encoded)
	if err != nil {
		t.Fatalf("decode request index: %v", err)
	}
	if decoded != "reservation-1" {
		t.Fatalf("request index decoded as %q", decoded)
	}
	if _, err := decodeRequestIndex([]byte("reservation-1")); err == nil {
		t.Fatal("plain text request index must be rejected as invalid Drunix JSON state")
	}
}
