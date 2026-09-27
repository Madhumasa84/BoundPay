package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

const (
	mandatePrefix          = "boundpay:mandate:"
	reservationPrefix      = "boundpay:reservation:"
	requestPrefix          = "boundpay:request:"
	passportMandatePrefix  = "boundpay:passport-mandate:"
	issuerKeyPrefix        = "boundpay:passport-issuer-key:"
	privateScopePrefix     = "boundpay:scope:"
	privateCollection      = "BoundPayParticipantsCollection"
	passportTransient      = "boundpay.passport.v1"
	scopeTransient         = "boundpay.scope.v1"
	purchaseProofTransient = "boundpay.purchase-proof.v1"
	passportTokenType      = "boundpay-authority-passport+jwt"
	active                 = "ACTIVE"
	revoked                = "REVOKED"
	reserved               = "RESERVED"
	dispatching            = "DISPATCHING"
	unknown                = "UNKNOWN"
	settled                = "SETTLED"
	released               = "RELEASED"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type SharedAuthorityContract struct {
	contractapi.Contract
}

type issuerKey struct {
	KeyID         string `json:"keyId"`
	OwnerMSP      string `json:"ownerMsp"`
	OwnerIdentity string `json:"ownerIdentity"`
	PublicKey     string `json:"publicKey"`
}

type passportMandateLink struct {
	MandateID string `json:"mandateId"`
}

type purchaseProof struct {
	Salt    string        `json:"salt"`
	Payload purchaseScope `json:"payload"`
}

type scopeProof struct {
	Salt    string     `json:"salt"`
	Payload scopeTerms `json:"payload"`
}

type scopeTerms struct {
	SchemaVersion      int      `json:"schemaVersion"`
	PolicyVersion      int64    `json:"policyVersion"`
	AllowedMerchantIDs []string `json:"allowedMerchantIds"`
	AllowedCategories  []string `json:"allowedCategories"`
}

type purchaseScope struct {
	SchemaVersion    int    `json:"schemaVersion"`
	RequestID        string `json:"requestId"`
	PaymentAttemptID string `json:"paymentAttemptId"`
	PassportID       string `json:"passportId"`
	AgentID          string `json:"agentId"`
	AmountPaise      int64  `json:"amountPaise"`
	Currency         string `json:"currency"`
	PaymentMode      string `json:"paymentAdapterMode"`
	IsSubscription   bool   `json:"isSubscription"`
	MerchantID       string `json:"merchantId"`
	Category         string `json:"category"`
	ProductID        string `json:"productId"`
	Quantity         int64  `json:"quantity"`
	UnitPricePaise   int64  `json:"unitPricePaise"`
}

type callerIdentity struct {
	MSPID    string `json:"mspId"`
	ClientID string `json:"clientId"`
}

type Mandate struct {
	SchemaVersion          int              `json:"schemaVersion"`
	MandateID              string           `json:"mandateId"`
	PassportID             string           `json:"passportId"`
	PassportDigest         string           `json:"passportDigest"`
	OwnerMSP               string           `json:"ownerMsp"`
	OwnerIdentity          string           `json:"ownerIdentity"`
	ParticipantMSPs        []string         `json:"participantMsps"`
	ParticipantIdentities  []callerIdentity `json:"participantIdentities"`
	VerifierIdentities     []callerIdentity `json:"verifierIdentities"`
	Currency               string           `json:"currency"`
	PaymentAdapterMode     string           `json:"paymentAdapterMode"`
	AggregateCapPaise      int64            `json:"aggregateCapPaise"`
	PerTransactionCapPaise int64            `json:"perTransactionCapPaise"`
	MaximumUsageCount      int64            `json:"maximumUsageCount"`
	PolicyVersion          int64            `json:"policyVersion"`
	ActiveUsageCount       int64            `json:"activeUsageCount"`
	ReservedPaise          int64            `json:"reservedPaise"`
	SettledPaise           int64            `json:"settledPaise"`
	ScopeCommitment        string           `json:"scopeCommitment"`
	Status                 string           `json:"status"`
	IssuedByTransactionID  string           `json:"issuedByTransactionId"`
	RevokedByTransactionID string           `json:"revokedByTransactionId"`
}

type Reservation struct {
	SchemaVersion         int    `json:"schemaVersion"`
	ReservationID         string `json:"reservationId"`
	MandateID             string `json:"mandateId"`
	RequestID             string `json:"requestId"`
	PaymentAttemptID      string `json:"paymentAttemptId"`
	PassportID            string `json:"passportId"`
	PassportDigest        string `json:"passportDigest"`
	ParticipantMSP        string `json:"participantMsp"`
	ExecutorIdentity      string `json:"executorIdentity"`
	AmountPaise           int64  `json:"amountPaise"`
	Currency              string `json:"currency"`
	PaymentAdapterMode    string `json:"paymentAdapterMode"`
	ScopeCommitment       string `json:"scopeCommitment"`
	RequestCommitment     string `json:"requestCommitment"`
	Status                string `json:"status"`
	ReserveTransactionID  string `json:"reserveTransactionId"`
	DispatchTransactionID string `json:"dispatchTransactionId"`
	UnknownTransactionID  string `json:"unknownTransactionId"`
	Outcome               string `json:"outcome"`
	EvidenceCommitment    string `json:"evidenceCommitment"`
	OutcomeTransactionID  string `json:"outcomeTransactionId"`
}

// RegisterPassportIssuerKey explicitly binds a BoundPay Ed25519 Passport
// verification key to the authenticated identity that controls it. A
// participant MSP cannot register or replace another owner's key.
func (c *SharedAuthorityContract) RegisterPassportIssuerKey(ctx contractapi.TransactionContextInterface, keyID, publicKeyPEM string) error {
	if err := validateID("passport key ID", keyID); err != nil {
		return err
	}
	_, _, err := caller(ctx)
	if err != nil {
		return err
	}
	block, _ := pem.Decode([]byte(publicKeyPEM))
	if block == nil {
		return errors.New("passport public key must be PEM encoded")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return fmt.Errorf("parse passport public key: %w", err)
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok || len(publicKey) != ed25519.PublicKeySize {
		return errors.New("passport public key must use Ed25519")
	}
	msp, identity, err := caller(ctx)
	if err != nil {
		return err
	}
	key := issuerKey{KeyID: keyID, OwnerMSP: msp, OwnerIdentity: identity, PublicKey: base64.RawStdEncoding.EncodeToString(publicKey)}
	stateKey := issuerKeyPrefix + keyID
	old, err := ctx.GetStub().GetState(stateKey)
	if err != nil {
		return fmt.Errorf("read passport issuer key: %w", err)
	}
	if old != nil {
		var prior issuerKey
		if err := json.Unmarshal(old, &prior); err != nil {
			return err
		}
		if prior == key {
			return nil
		}
		return errors.New("passport key ID is already registered to another key or identity")
	}
	return putJSON(ctx, stateKey, key)
}

// IssueMandate verifies the signed Authority Passport in transient data,
// derives the maximum enforceable limits from its signed claims, and stores
// only its digest and the salted allowlist commitment on the shared ledger.
func (c *SharedAuthorityContract) IssueMandate(
	ctx contractapi.TransactionContextInterface,
	mandateID, passportID, passportDigest, currency, aggregateCapText,
	perTransactionCapText, maximumUsageText, scopeCommitment,
	participantIdentitiesJSON, verifierIdentitiesJSON string,
) (*Mandate, error) {
	if err := validateID("mandate ID", mandateID); err != nil {
		return nil, err
	}
	if err := validateID("passport ID", passportID); err != nil {
		return nil, err
	}
	if !digest.MatchString(passportDigest) || !digest.MatchString(scopeCommitment) {
		return nil, errors.New("passport and scope commitments must be lowercase SHA-256 hex")
	}
	if currency != "INR" {
		return nil, errors.New("only INR mandates are supported")
	}
	aggregateCap, err := positiveInt64("aggregate cap", aggregateCapText)
	if err != nil {
		return nil, err
	}
	perTransactionCap, err := positiveInt64("per-transaction cap", perTransactionCapText)
	if err != nil {
		return nil, err
	}
	maximumUsage, err := positiveInt64("maximum usage count", maximumUsageText)
	if err != nil {
		return nil, err
	}
	if perTransactionCap > aggregateCap {
		return nil, errors.New("per-transaction cap cannot exceed aggregate cap")
	}
	if aggregateCap > 9007199254740991 || perTransactionCap > 9007199254740991 {
		return nil, errors.New("amount exceeds the safe integer paise range")
	}
	participants, err := parseIdentities(participantIdentitiesJSON)
	if err != nil {
		return nil, fmt.Errorf("participant identities: %w", err)
	}
	verifiers, err := parseIdentities(verifierIdentitiesJSON)
	if err != nil {
		return nil, fmt.Errorf("verifier list: %w", err)
	}
	if len(participants) == 0 || len(verifiers) == 0 {
		return nil, errors.New("at least one participant identity and verifier identity are required")
	}
	participantMSPs := identityMSPs(participants)
	ownerMSP, ownerIdentity, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, fmt.Errorf("read Passport transient data: %w", err)
	}
	passportToken := string(transient[passportTransient])
	claims, verifiedDigest, err := verifyPassportToken(ctx, passportToken, ownerMSP, ownerIdentity)
	if err != nil {
		return nil, err
	}
	if verifiedDigest != passportDigest || stringClaim(claims, "passportId") != passportID {
		return nil, errors.New("signed Passport does not match the requested mandate binding")
	}
	if stringClaim(claims, "currency") != currency {
		return nil, errors.New("mandate currency exceeds the signed Passport")
	}
	paymentMode := stringClaim(claims, "paymentAdapterMode")
	if paymentMode != "MOCK" && paymentMode != "RAZORPAY_TEST" {
		return nil, errors.New("signed Passport payment adapter mode is unsupported")
	}
	passportAggregate, err := integerClaim(claims, "cumulativeBudgetPaise")
	if err != nil {
		return nil, err
	}
	passportPerTransaction, err := integerClaim(claims, "maximumAmountPerTransactionPaise")
	if err != nil {
		return nil, err
	}
	passportUsage, err := integerClaim(claims, "maximumUsageCount")
	if err != nil {
		return nil, err
	}
	if aggregateCap > passportAggregate || perTransactionCap > passportPerTransaction || maximumUsage > passportUsage {
		return nil, errors.New("shared mandate cannot exceed signed Passport limits")
	}
	var scope scopeProof
	if err := decodeStrict(transient[scopeTransient], &scope); err != nil {
		return nil, fmt.Errorf("private scope proof: %w", err)
	}
	if scope.Payload.SchemaVersion != 1 || scope.Payload.PolicyVersion <= 0 || len(scope.Payload.AllowedMerchantIDs) == 0 || len(scope.Payload.AllowedCategories) == 0 {
		return nil, errors.New("private scope proof is incomplete")
	}
	if commitment("passport-scope", decodeSalt(scope.Salt), scope.Payload) != scopeCommitment {
		return nil, errors.New("scope commitment does not match the private mandate scope")
	}
	if err := validateScopeTerms(scope.Payload, claims); err != nil {
		return nil, err
	}

	mandate := &Mandate{
		SchemaVersion: 1, MandateID: mandateID, PassportID: passportID,
		PassportDigest: passportDigest, OwnerMSP: ownerMSP, OwnerIdentity: ownerIdentity,
		ParticipantMSPs: participantMSPs, ParticipantIdentities: participants, VerifierIdentities: verifiers, Currency: currency,
		PaymentAdapterMode: paymentMode,
		AggregateCapPaise:  aggregateCap, PerTransactionCapPaise: perTransactionCap,
		MaximumUsageCount: maximumUsage, ScopeCommitment: scopeCommitment,
		PolicyVersion: scope.Payload.PolicyVersion,
		Status:        active, IssuedByTransactionID: ctx.GetStub().GetTxID(),
	}
	passportIndexKey := passportMandateIndexKey(passportID)
	passportIndexBytes, err := ctx.GetStub().GetState(passportIndexKey)
	if err != nil {
		return nil, fmt.Errorf("read Passport mandate binding: %w", err)
	}
	if err := checkPassportMandateBinding(passportIndexBytes, mandateID); err != nil {
		return nil, err
	}
	key := mandateKey(mandateID)
	priorBytes, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, fmt.Errorf("read mandate: %w", err)
	}
	if priorBytes != nil {
		var prior Mandate
		if err := json.Unmarshal(priorBytes, &prior); err != nil {
			return nil, fmt.Errorf("decode existing mandate: %w", err)
		}
		if prior.OwnerMSP == ownerMSP && prior.OwnerIdentity == ownerIdentity && sameMandateTerms(&prior, mandate) {
			if passportIndexBytes == nil {
				if err := putJSON(ctx, passportIndexKey, passportMandateLink{MandateID: mandateID}); err != nil {
					return nil, err
				}
			}
			return &prior, nil
		}
		return nil, errors.New("mandate ID is already bound to different terms or owner")
	}
	privateScopeBytes, err := json.Marshal(scope)
	if err != nil {
		return nil, fmt.Errorf("encode private mandate scope: %w", err)
	}
	if err := ctx.GetStub().PutPrivateData(privateCollection, privateScopeKey(mandateID), privateScopeBytes); err != nil {
		return nil, fmt.Errorf("store private mandate scope: %w", err)
	}
	if err := putJSON(ctx, key, mandate); err != nil {
		return nil, err
	}
	if err := putJSON(ctx, passportIndexKey, passportMandateLink{MandateID: mandateID}); err != nil {
		return nil, err
	}
	return mandate, nil
}

// Reserve atomically updates the mandate budget key and stores one immutable
// request binding. Drunix MVCC rejects a competing stale simulation.
func (c *SharedAuthorityContract) Reserve(
	ctx contractapi.TransactionContextInterface,
	mandateID, reservationID, requestID, paymentAttemptID, passportID,
	passportDigest, amountText, currency, scopeCommitment, requestCommitment string,
) (*Reservation, error) {
	if err := validateID("mandate ID", mandateID); err != nil {
		return nil, err
	}
	if err := validateID("reservation ID", reservationID); err != nil {
		return nil, err
	}
	if err := validateID("request ID", requestID); err != nil {
		return nil, err
	}
	if err := validateID("payment attempt ID", paymentAttemptID); err != nil {
		return nil, err
	}
	if err := validateID("passport ID", passportID); err != nil {
		return nil, err
	}
	if !digest.MatchString(passportDigest) || !digest.MatchString(scopeCommitment) || !digest.MatchString(requestCommitment) {
		return nil, errors.New("commitments must be lowercase SHA-256 hex")
	}
	amount, err := positiveInt64("reservation amount", amountText)
	if err != nil {
		return nil, err
	}
	if amount > 9007199254740991 {
		return nil, errors.New("amount exceeds the safe integer paise range")
	}
	mspID, identityID, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	mandate, err := readMandate(ctx, mandateID)
	if err != nil {
		return nil, err
	}
	if !isParticipant(*mandate, mspID, identityID) {
		return nil, errors.New("authenticated caller identity is not an authorized participant")
	}
	if passportID != mandate.PassportID || passportDigest != mandate.PassportDigest {
		return nil, errors.New("reservation does not match the mandate passport binding")
	}
	if currency != mandate.Currency || amount > mandate.PerTransactionCapPaise || scopeCommitment != mandate.ScopeCommitment {
		return nil, errors.New("reservation exceeds mandate currency, transaction, or scope limit")
	}
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, fmt.Errorf("read private reservation proof: %w", err)
	}
	claims, verifiedDigest, err := verifyPassportToken(ctx, string(transient[passportTransient]), mandate.OwnerMSP, mandate.OwnerIdentity)
	if err != nil {
		return nil, err
	}
	if verifiedDigest != mandate.PassportDigest || stringClaim(claims, "passportId") != mandate.PassportID {
		return nil, errors.New("signed Passport no longer matches the mandate")
	}
	var proof purchaseProof
	if err := decodeStrict(transient[purchaseProofTransient], &proof); err != nil {
		return nil, fmt.Errorf("private reservation proof: %w", err)
	}
	if proof.Payload.SchemaVersion != 1 || proof.Payload.RequestID != requestID || proof.Payload.PaymentAttemptID != paymentAttemptID || proof.Payload.PassportID != passportID || proof.Payload.AmountPaise != amount || proof.Payload.Currency != currency {
		return nil, errors.New("private purchase proof does not match reservation fields")
	}
	if proof.Payload.AgentID != stringClaim(claims, "agentId") || proof.Payload.PaymentMode != mandate.PaymentAdapterMode || proof.Payload.IsSubscription {
		return nil, errors.New("purchase agent or payment mode is not authorized, or subscription purchases are prohibited")
	}
	if err := validateID("agent ID", proof.Payload.AgentID); err != nil {
		return nil, err
	}
	if err := validateID("merchant ID", proof.Payload.MerchantID); err != nil {
		return nil, err
	}
	if err := validateID("category", proof.Payload.Category); err != nil {
		return nil, err
	}
	if err := validateID("product ID", proof.Payload.ProductID); err != nil {
		return nil, err
	}
	if proof.Payload.Quantity <= 0 || proof.Payload.UnitPricePaise <= 0 || proof.Payload.Quantity > 9007199254740991/proof.Payload.UnitPricePaise || proof.Payload.Quantity*proof.Payload.UnitPricePaise != amount {
		return nil, errors.New("purchase proof total does not equal reserved amount")
	}
	if commitment("purchase-scope", decodeSalt(proof.Salt), proof.Payload) != requestCommitment {
		return nil, errors.New("purchase commitment does not match private purchase proof")
	}
	privateScopeBytes, err := ctx.GetStub().GetPrivateData(privateCollection, privateScopeKey(mandateID))
	if err != nil || privateScopeBytes == nil {
		return nil, errors.New("private mandate scope is unavailable")
	}
	var scope scopeProof
	if err := decodeStrict(privateScopeBytes, &scope); err != nil {
		return nil, errors.New("stored private mandate scope is malformed")
	}
	if commitment("passport-scope", decodeSalt(scope.Salt), scope.Payload) != mandate.ScopeCommitment || scope.Payload.PolicyVersion != mandate.PolicyVersion {
		return nil, errors.New("stored private mandate scope does not match its public commitment")
	}
	if !contains(scope.Payload.AllowedMerchantIDs, proof.Payload.MerchantID) || !contains(scope.Payload.AllowedCategories, proof.Payload.Category) {
		return nil, errors.New("purchase scope is not allowed by the shared mandate")
	}
	if !stringArrayContains(claims["allowedMerchantIds"], proof.Payload.MerchantID) || !stringArrayContains(claims["allowedCategories"], proof.Payload.Category) {
		return nil, errors.New("purchase scope is not allowed by the signed Passport")
	}
	resKey := reservationKey(mandateID, reservationID)
	requestKey := requestIndexKey(mandateID, requestID)
	if oldBytes, err := ctx.GetStub().GetState(resKey); err != nil {
		return nil, err
	} else if oldBytes != nil {
		var old Reservation
		if err := json.Unmarshal(oldBytes, &old); err != nil {
			return nil, fmt.Errorf("decode existing reservation: %w", err)
		}
		candidate := reservationFrom(mandateID, reservationID, requestID, paymentAttemptID, passportID, passportDigest, mspID, identityID, amount, currency, mandate.PaymentAdapterMode, scopeCommitment, requestCommitment, ctx.GetStub().GetTxID())
		if sameReservationRequest(old, *candidate) {
			return &old, nil
		}
		return nil, errors.New("reservation ID was reused with different transaction contents")
	}
	if oldRequest, err := ctx.GetStub().GetState(requestKey); err != nil {
		return nil, err
	} else if oldRequest != nil {
		previousReservationID, err := decodeRequestIndex(oldRequest)
		if err != nil {
			return nil, fmt.Errorf("decode request index: %w", err)
		}
		if previousReservationID != reservationID {
			return nil, errors.New("business request ID is already bound to a different reservation")
		}
		return nil, errors.New("request ID reservation index is inconsistent")
	}
	if mandate.Status != active {
		return nil, errors.New("mandate is revoked; new reservations are blocked")
	}
	if mandate.ActiveUsageCount >= mandate.MaximumUsageCount {
		return nil, errors.New("mandate usage count exhausted")
	}
	if !hasSharedAllowance(*mandate, amount) {
		return nil, errors.New("shared mandate allowance is insufficient")
	}

	reservation := reservationFrom(mandateID, reservationID, requestID, paymentAttemptID, passportID, passportDigest, mspID, identityID, amount, currency, mandate.PaymentAdapterMode, scopeCommitment, requestCommitment, ctx.GetStub().GetTxID())
	mandate.ReservedPaise += amount
	mandate.ActiveUsageCount++
	if err := putJSON(ctx, mandateKey(mandateID), mandate); err != nil {
		return nil, err
	}
	if err := putJSON(ctx, resKey, reservation); err != nil {
		return nil, err
	}
	requestIndexValue, err := encodeRequestIndex(reservationID)
	if err != nil {
		return nil, fmt.Errorf("encode request index: %w", err)
	}
	if err := ctx.GetStub().PutState(requestKey, requestIndexValue); err != nil {
		return nil, fmt.Errorf("write request index: %w", err)
	}
	return reservation, nil
}

// BeginDispatch is a one-time, committed dispatch claim. A caller must verify
// this transaction's successful commit and query the matching state before it
// calls a payment provider. A retry after the transition cannot issue another
// dispatch claim.
func (c *SharedAuthorityContract) BeginDispatch(ctx contractapi.TransactionContextInterface, mandateID, reservationID string) (*Reservation, error) {
	return c.changeReservation(ctx, mandateID, reservationID, func(m *Mandate, r *Reservation, msp, identity string) error {
		if !canClaimDispatch(*m, *r, msp, identity) {
			return errors.New("only the authenticated executor of a RESERVED entry may claim dispatch")
		}
		r.Status = dispatching
		r.DispatchTransactionID = ctx.GetStub().GetTxID()
		return nil
	})
}

func (c *SharedAuthorityContract) MarkUnknown(ctx contractapi.TransactionContextInterface, mandateID, reservationID string) (*Reservation, error) {
	return c.changeReservation(ctx, mandateID, reservationID, func(m *Mandate, r *Reservation, msp, identity string) error {
		if !canResolve(*m, *r, msp, identity) {
			return errors.New("caller cannot update this reservation")
		}
		if r.Status == unknown {
			return nil
		}
		if r.Status != dispatching {
			return errors.New("only a dispatching reservation can become unknown")
		}
		r.Status = unknown
		r.UnknownTransactionID = ctx.GetStub().GetTxID()
		return nil
	})
}

func (c *SharedAuthorityContract) CommitOutcome(ctx contractapi.TransactionContextInterface, mandateID, reservationID, evidenceCommitment string) (*Reservation, error) {
	if !digest.MatchString(evidenceCommitment) {
		return nil, errors.New("evidence commitment must be lowercase SHA-256 hex")
	}
	return c.changeReservation(ctx, mandateID, reservationID, func(m *Mandate, r *Reservation, msp, identity string) error {
		if !isVerifier(*m, msp, identity) {
			return errors.New("only a configured verifier identity can confirm a payment outcome")
		}
		if r.Status == settled {
			if r.Outcome == "SUCCESS" && r.EvidenceCommitment == evidenceCommitment {
				return nil
			}
			return errors.New("settled outcome cannot be changed")
		}
		if r.Status != dispatching && r.Status != unknown {
			return errors.New("only a dispatched reservation can record a successful outcome")
		}
		if m.ReservedPaise < r.AmountPaise {
			return errors.New("mandate reserved balance is inconsistent")
		}
		m.ReservedPaise -= r.AmountPaise
		m.SettledPaise += r.AmountPaise
		r.Status = settled
		r.Outcome = "SUCCESS"
		r.EvidenceCommitment = evidenceCommitment
		r.OutcomeTransactionID = ctx.GetStub().GetTxID()
		return nil
	})
}

// ReleaseDefinitiveFailure accepts only a terminal provider-failure evidence
// commitment. UNKNOWN and DISPATCHING records can be released only by a
// registered verifier, after off-chain reconciliation proves no settlement.
func (c *SharedAuthorityContract) ReleaseDefinitiveFailure(ctx contractapi.TransactionContextInterface, mandateID, reservationID, evidenceCommitment string) (*Reservation, error) {
	if !digest.MatchString(evidenceCommitment) {
		return nil, errors.New("failure evidence commitment must be lowercase SHA-256 hex")
	}
	return c.changeReservation(ctx, mandateID, reservationID, func(m *Mandate, r *Reservation, msp, identity string) error {
		if r.Status == released {
			if !isVerifier(*m, msp, identity) {
				return errors.New("only a configured verifier identity can confirm a released outcome")
			}
			if r.Outcome == "DEFINITIVE_FAILURE" && r.EvidenceCommitment == evidenceCommitment {
				return nil
			}
			return errors.New("released outcome cannot be changed")
		}
		if r.Status != reserved && r.Status != dispatching && r.Status != unknown {
			return errors.New("reservation cannot be released from its current state")
		}
		if !canReleaseReservation(*m, *r, msp, identity) {
			return errors.New("caller cannot release the reservation from its current state")
		}
		if m.ReservedPaise < r.AmountPaise || m.ActiveUsageCount <= 0 {
			return errors.New("mandate reserved counters are inconsistent")
		}
		m.ReservedPaise -= r.AmountPaise
		m.ActiveUsageCount--
		r.Status = released
		r.Outcome = "DEFINITIVE_FAILURE"
		r.EvidenceCommitment = evidenceCommitment
		r.OutcomeTransactionID = ctx.GetStub().GetTxID()
		return nil
	})
}

// RevokeFutureAuthority is prospective: existing reservations are unchanged.
func (c *SharedAuthorityContract) RevokeFutureAuthority(ctx contractapi.TransactionContextInterface, mandateID string) (*Mandate, error) {
	if err := validateID("mandate ID", mandateID); err != nil {
		return nil, err
	}
	m, identity, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	mandate, err := readMandate(ctx, mandateID)
	if err != nil {
		return nil, err
	}
	if !isMandateOwner(*mandate, m, identity) {
		return nil, errors.New("only the identity that issued this mandate may revoke it")
	}
	if mandate.Status == revoked {
		return mandate, nil
	}
	mandate.Status = revoked
	mandate.RevokedByTransactionID = ctx.GetStub().GetTxID()
	if err := putJSON(ctx, mandateKey(mandateID), mandate); err != nil {
		return nil, err
	}
	return mandate, nil
}

func (c *SharedAuthorityContract) QueryMandate(ctx contractapi.TransactionContextInterface, mandateID string) (*Mandate, error) {
	if err := validateID("mandate ID", mandateID); err != nil {
		return nil, err
	}
	mandate, err := readMandate(ctx, mandateID)
	if err != nil {
		return nil, err
	}
	msp, identity, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	if !canRead(*mandate, msp, identity) {
		return nil, errors.New("caller cannot read this mandate")
	}
	return mandate, nil
}

// GetCallerIdentity returns the MSP and certificate-derived identity used by
// this signed Gateway session. Recovery checks it against the reservation's
// immutable executor binding before considering a dispatch.
func (c *SharedAuthorityContract) GetCallerIdentity(ctx contractapi.TransactionContextInterface) (*callerIdentity, error) {
	msp, identity, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	return &callerIdentity{MSPID: msp, ClientID: identity}, nil
}

func (c *SharedAuthorityContract) QueryReservation(ctx contractapi.TransactionContextInterface, mandateID, reservationID string) (*Reservation, error) {
	if err := validateID("mandate ID", mandateID); err != nil {
		return nil, err
	}
	if err := validateID("reservation ID", reservationID); err != nil {
		return nil, err
	}
	mandate, err := readMandate(ctx, mandateID)
	if err != nil {
		return nil, err
	}
	msp, identity, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	if !canRead(*mandate, msp, identity) {
		return nil, errors.New("caller cannot read this reservation")
	}
	return readReservation(ctx, mandateID, reservationID)
}

func (c *SharedAuthorityContract) QueryReservations(ctx contractapi.TransactionContextInterface, mandateID string) ([]*Reservation, error) {
	if err := validateID("mandate ID", mandateID); err != nil {
		return nil, err
	}
	mandate, err := readMandate(ctx, mandateID)
	if err != nil {
		return nil, err
	}
	msp, identity, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	if !canRead(*mandate, msp, identity) {
		return nil, errors.New("caller cannot read this mandate")
	}
	iterator, err := ctx.GetStub().GetStateByRange(reservationPrefix+mandateID+":", reservationPrefix+mandateID+":~")
	if err != nil {
		return nil, fmt.Errorf("query reservations: %w", err)
	}
	defer iterator.Close()
	items := make([]*Reservation, 0)
	for iterator.HasNext() {
		entry, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		var item Reservation
		if err := json.Unmarshal(entry.Value, &item); err != nil {
			return nil, fmt.Errorf("decode reservation: %w", err)
		}
		items = append(items, &item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ReservationID < items[j].ReservationID })
	return items, nil
}

func (c *SharedAuthorityContract) changeReservation(
	ctx contractapi.TransactionContextInterface, mandateID, reservationID string,
	change func(*Mandate, *Reservation, string, string) error,
) (*Reservation, error) {
	if err := validateID("mandate ID", mandateID); err != nil {
		return nil, err
	}
	if err := validateID("reservation ID", reservationID); err != nil {
		return nil, err
	}
	m, err := readMandate(ctx, mandateID)
	if err != nil {
		return nil, err
	}
	r, err := readReservation(ctx, mandateID, reservationID)
	if err != nil {
		return nil, err
	}
	msp, identity, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	if err := change(m, r, msp, identity); err != nil {
		return nil, err
	}
	if err := putJSON(ctx, mandateKey(mandateID), m); err != nil {
		return nil, err
	}
	if err := putJSON(ctx, reservationKey(mandateID, reservationID), r); err != nil {
		return nil, err
	}
	return r, nil
}

func canResolve(m Mandate, r Reservation, msp, identity string) bool {
	return (msp == r.ParticipantMSP && identity == r.ExecutorIdentity) || isVerifier(m, msp, identity)
}

func canRead(m Mandate, msp, identity string) bool {
	return isMandateOwner(m, msp, identity) || isParticipant(m, msp, identity) || isVerifier(m, msp, identity)
}

func isParticipant(m Mandate, msp, identity string) bool {
	for _, participant := range m.ParticipantIdentities {
		if participant.MSPID == msp && participant.ClientID == identity {
			return true
		}
	}
	return false
}

func isVerifier(m Mandate, msp, identity string) bool {
	for _, verifier := range m.VerifierIdentities {
		if verifier.MSPID == msp && verifier.ClientID == identity {
			return true
		}
	}
	return false
}

func isMandateOwner(m Mandate, msp, identity string) bool {
	return m.OwnerMSP == msp && m.OwnerIdentity == identity
}

func canClaimDispatch(m Mandate, r Reservation, msp, identity string) bool {
	return r.Status == reserved && r.ParticipantMSP == msp && r.ExecutorIdentity == identity && isParticipant(m, msp, identity)
}

func canCommitOutcome(m Mandate, r Reservation, msp, identity string) bool {
	return (r.Status == dispatching || r.Status == unknown) && isVerifier(m, msp, identity)
}

func canReleaseReservation(m Mandate, r Reservation, msp, identity string) bool {
	if r.Status == reserved {
		return (r.ParticipantMSP == msp && r.ExecutorIdentity == identity) || isVerifier(m, msp, identity)
	}
	return (r.Status == dispatching || r.Status == unknown) && isVerifier(m, msp, identity)
}

func hasSharedAllowance(m Mandate, amount int64) bool {
	if amount <= 0 || amount > m.AggregateCapPaise || m.ReservedPaise < 0 || m.SettledPaise < 0 || m.ReservedPaise > m.AggregateCapPaise || m.SettledPaise > m.AggregateCapPaise {
		return false
	}
	if m.ReservedPaise > m.AggregateCapPaise-m.SettledPaise {
		return false
	}
	return amount <= m.AggregateCapPaise-m.SettledPaise-m.ReservedPaise
}

func reservationFrom(mandateID, reservationID, requestID, paymentAttemptID, passportID, passportDigest, mspID, identityID string, amount int64, currency, paymentMode, scopeCommitment, requestCommitment, txID string) *Reservation {
	return &Reservation{
		SchemaVersion: 1, ReservationID: reservationID, MandateID: mandateID,
		RequestID: requestID, PaymentAttemptID: paymentAttemptID, PassportID: passportID,
		PassportDigest: passportDigest, ParticipantMSP: mspID, ExecutorIdentity: identityID,
		AmountPaise: amount, Currency: currency, PaymentAdapterMode: paymentMode, ScopeCommitment: scopeCommitment,
		RequestCommitment: requestCommitment, Status: reserved, ReserveTransactionID: txID,
	}
}

func sameReservationRequest(a, b Reservation) bool {
	return a.MandateID == b.MandateID && a.ReservationID == b.ReservationID && a.RequestID == b.RequestID &&
		a.PaymentAttemptID == b.PaymentAttemptID && a.PassportID == b.PassportID && a.PassportDigest == b.PassportDigest &&
		a.ParticipantMSP == b.ParticipantMSP && a.ExecutorIdentity == b.ExecutorIdentity && a.AmountPaise == b.AmountPaise &&
		a.Currency == b.Currency && a.PaymentAdapterMode == b.PaymentAdapterMode && a.ScopeCommitment == b.ScopeCommitment && a.RequestCommitment == b.RequestCommitment
}

func sameMandateTerms(a, b *Mandate) bool {
	return a.MandateID == b.MandateID && a.PassportID == b.PassportID && a.PassportDigest == b.PassportDigest &&
		a.Currency == b.Currency && a.PaymentAdapterMode == b.PaymentAdapterMode && a.AggregateCapPaise == b.AggregateCapPaise &&
		a.PerTransactionCapPaise == b.PerTransactionCapPaise && a.MaximumUsageCount == b.MaximumUsageCount && a.PolicyVersion == b.PolicyVersion &&
		a.ScopeCommitment == b.ScopeCommitment && equalStrings(a.ParticipantMSPs, b.ParticipantMSPs) &&
		equalIdentities(a.ParticipantIdentities, b.ParticipantIdentities) && equalIdentities(a.VerifierIdentities, b.VerifierIdentities)
}

func readMandate(ctx contractapi.TransactionContextInterface, id string) (*Mandate, error) {
	data, err := ctx.GetStub().GetState(mandateKey(id))
	if err != nil {
		return nil, fmt.Errorf("read mandate: %w", err)
	}
	if data == nil {
		return nil, errors.New("mandate not found")
	}
	var item Mandate
	if err := json.Unmarshal(data, &item); err != nil {
		return nil, fmt.Errorf("decode mandate: %w", err)
	}
	return &item, nil
}

func readReservation(ctx contractapi.TransactionContextInterface, mandateID, id string) (*Reservation, error) {
	data, err := ctx.GetStub().GetState(reservationKey(mandateID, id))
	if err != nil {
		return nil, fmt.Errorf("read reservation: %w", err)
	}
	if data == nil {
		return nil, errors.New("reservation not found")
	}
	var item Reservation
	if err := json.Unmarshal(data, &item); err != nil {
		return nil, fmt.Errorf("decode reservation: %w", err)
	}
	return &item, nil
}

func caller(ctx contractapi.TransactionContextInterface) (string, string, error) {
	identity := ctx.GetClientIdentity()
	if identity == nil {
		return "", "", errors.New("authenticated client identity unavailable")
	}
	msp, err := identity.GetMSPID()
	if err != nil {
		return "", "", fmt.Errorf("read caller MSP: %w", err)
	}
	id, err := identity.GetID()
	if err != nil {
		return "", "", fmt.Errorf("read caller identity: %w", err)
	}
	if strings.TrimSpace(msp) == "" || strings.TrimSpace(id) == "" {
		return "", "", errors.New("authenticated caller identity is empty")
	}
	return msp, id, nil
}

func parseMSPs(raw string) ([]string, error) {
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, errors.New("must be a JSON string array")
	}
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if !safeID.MatchString(value) || seen[value] {
			return nil, errors.New("must contain unique safe MSP IDs")
		}
		seen[value] = true
	}
	sort.Strings(values)
	return values, nil
}

func parseIdentities(raw string) ([]callerIdentity, error) {
	var values []callerIdentity
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, errors.New("must be a JSON array of {mspId, clientId} identities")
	}
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if !safeID.MatchString(value.MSPID) || strings.TrimSpace(value.ClientID) == "" || len(value.ClientID) > 2048 || strings.ContainsAny(value.ClientID, "\r\n\x00") {
			return nil, errors.New("identity contains an invalid MSP or certificate identity")
		}
		key := value.MSPID + "\x00" + value.ClientID
		if seen[key] {
			return nil, errors.New("identities must be unique")
		}
		seen[key] = true
	}
	sort.Slice(values, func(i, j int) bool {
		if values[i].MSPID == values[j].MSPID {
			return values[i].ClientID < values[j].ClientID
		}
		return values[i].MSPID < values[j].MSPID
	})
	return values, nil
}

func identityMSPs(values []callerIdentity) []string {
	seen := make(map[string]bool, len(values))
	msps := make([]string, 0, len(values))
	for _, value := range values {
		if !seen[value.MSPID] {
			seen[value.MSPID] = true
			msps = append(msps, value.MSPID)
		}
	}
	sort.Strings(msps)
	return msps
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalIdentities(a, b []callerIdentity) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func validateID(name, value string) error {
	if !safeID.MatchString(value) {
		return fmt.Errorf("%s is not a safe identifier", name)
	}
	return nil
}

func positiveInt64(name, value string) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != value {
		return 0, fmt.Errorf("%s must be a positive canonical integer", name)
	}
	return n, nil
}

func mandateKey(id string) string                      { return mandatePrefix + id }
func reservationKey(mandateID, id string) string       { return reservationPrefix + mandateID + ":" + id }
func requestIndexKey(mandateID, id string) string      { return requestPrefix + mandateID + ":" + id }
func passportMandateIndexKey(passportID string) string { return passportMandatePrefix + passportID }

func checkPassportMandateBinding(value []byte, requestedMandateID string) error {
	if value == nil {
		return nil
	}
	var link passportMandateLink
	if err := json.Unmarshal(value, &link); err != nil || validateID("existing Passport mandate ID", link.MandateID) != nil {
		return errors.New("existing Passport mandate binding is malformed")
	}
	if link.MandateID != requestedMandateID {
		return errors.New("this Authority Passport is already bound to a shared mandate; issue a new Passport before creating another allowance")
	}
	return nil
}

// Drunix v1.0.0's Yugabyte-backed state database stores values in a JSON
// column. Even scalar index values must therefore be JSON encoded.
func encodeRequestIndex(reservationID string) ([]byte, error) {
	return json.Marshal(reservationID)
}

func decodeRequestIndex(value []byte) (string, error) {
	var reservationID string
	if err := json.Unmarshal(value, &reservationID); err != nil {
		return "", err
	}
	return reservationID, nil
}
func privateScopeKey(mandateID string) string { return privateScopePrefix + mandateID }

func putJSON(ctx contractapi.TransactionContextInterface, key string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode ledger state: %w", err)
	}
	if err := ctx.GetStub().PutState(key, data); err != nil {
		return fmt.Errorf("write ledger state: %w", err)
	}
	return nil
}

func verifyPassportToken(ctx contractapi.TransactionContextInterface, token, ownerMSP, ownerIdentity string) (map[string]any, string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(token) > 32768 {
		return nil, "", errors.New("malformed signed Authority Passport")
	}
	for _, part := range parts {
		if part == "" {
			return nil, "", errors.New("malformed compact Passport token")
		}
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || base64.RawURLEncoding.EncodeToString(headerBytes) != parts[0] {
		return nil, "", errors.New("non-canonical Passport header")
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(payloadBytes) != parts[1] {
		return nil, "", errors.New("non-canonical Passport payload")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || base64.RawURLEncoding.EncodeToString(signature) != parts[2] || len(signature) != ed25519.SignatureSize {
		return nil, "", errors.New("malformed Passport signature")
	}
	var header map[string]any
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, "", errors.New("malformed Passport header JSON")
	}
	var claims map[string]any
	decoder := json.NewDecoder(bytes.NewReader(payloadBytes))
	decoder.UseNumber()
	if err := decoder.Decode(&claims); err != nil {
		return nil, "", errors.New("malformed Passport payload JSON")
	}
	if err := ensureEOF(decoder); err != nil {
		return nil, "", errors.New("trailing Passport JSON")
	}
	keyID := stringClaim(header, "kid")
	if stringClaim(header, "alg") != "EdDSA" || stringClaim(header, "typ") != passportTokenType || stringClaim(claims, "keyId") != keyID {
		return nil, "", errors.New("unsupported Passport signature algorithm or token type")
	}
	keyBytes, err := ctx.GetStub().GetState(issuerKeyPrefix + keyID)
	if err != nil || keyBytes == nil {
		return nil, "", errors.New("Passport issuer key is not registered")
	}
	var issuer issuerKey
	if err := json.Unmarshal(keyBytes, &issuer); err != nil {
		return nil, "", errors.New("stored Passport issuer key is malformed")
	}
	if issuer.OwnerMSP != ownerMSP || issuer.OwnerIdentity != ownerIdentity {
		return nil, "", errors.New("Passport key is not bound to the mandate owner identity")
	}
	publicKey, err := base64.RawStdEncoding.DecodeString(issuer.PublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return nil, "", errors.New("stored Passport public key is invalid")
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), []byte(parts[0]+"."+parts[1]), signature) {
		return nil, "", errors.New("Authority Passport signature verification failed")
	}
	if numberClaim(claims, "schemaVersion") != 1 {
		return nil, "", errors.New("unsupported Authority Passport schema version")
	}
	canonical, err := canonicalJSON(claims)
	if err != nil {
		return nil, "", err
	}
	digestBytes := sha256.Sum256(canonical)
	return claims, fmt.Sprintf("%x", digestBytes), nil
}

func commitment(kind string, salt []byte, payload any) string {
	if len(salt) != 32 {
		return ""
	}
	canonical, err := canonicalJSON(payload)
	if err != nil {
		return ""
	}
	preimage := append([]byte("boundpay:commit:v1:"+kind+"\x00"), salt...)
	preimage = append(preimage, canonical...)
	sum := sha256.Sum256(preimage)
	return fmt.Sprintf("%x", sum)
}

func decodeSalt(value string) []byte {
	salt, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(salt) != value {
		return nil
	}
	return salt
}

func canonicalJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return nil, err
	}
	var output bytes.Buffer
	if err := writeCanonicalJSON(&output, parsed); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func writeCanonicalJSON(output *bytes.Buffer, value any) error {
	switch typed := value.(type) {
	case nil:
		output.WriteString("null")
	case bool:
		if typed {
			output.WriteString("true")
		} else {
			output.WriteString("false")
		}
	case string:
		var encoded bytes.Buffer
		encoder := json.NewEncoder(&encoded)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(typed); err != nil {
			return err
		}
		output.Write(bytes.TrimSuffix(encoded.Bytes(), []byte("\n")))
	case json.Number:
		integer, err := strconv.ParseInt(typed.String(), 10, 64)
		if err != nil || strconv.FormatInt(integer, 10) != typed.String() {
			return errors.New("canonical commitments accept integer numbers only")
		}
		output.WriteString(strconv.FormatInt(integer, 10))
	case []any:
		output.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeCanonicalJSON(output, item); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		output.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := writeCanonicalJSON(output, key); err != nil {
				return err
			}
			output.WriteByte(':')
			if err := writeCanonicalJSON(output, typed[key]); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return fmt.Errorf("unsupported canonical JSON value %T", value)
	}
	return nil
}

func decodeStrict(data []byte, target any) error {
	if len(data) == 0 {
		return errors.New("required transient value is missing")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return ensureEOF(decoder)
}

func ensureEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); err == io.EOF {
		return nil
	} else if err != nil {
		return err
	}
	return errors.New("unexpected trailing JSON value")
}

func stringClaim(claims map[string]any, key string) string {
	value, _ := claims[key].(string)
	return value
}

func integerClaim(claims map[string]any, key string) (int64, error) {
	value, ok := claims[key].(json.Number)
	if !ok {
		return 0, fmt.Errorf("signed Passport %s claim is not an integer", key)
	}
	parsed, err := strconv.ParseInt(value.String(), 10, 64)
	if err != nil || parsed <= 0 || strconv.FormatInt(parsed, 10) != value.String() {
		return 0, fmt.Errorf("signed Passport %s claim is invalid", key)
	}
	return parsed, nil
}

func numberClaim(claims map[string]any, key string) int64 {
	value, ok := claims[key].(json.Number)
	if !ok {
		return 0
	}
	parsed, err := strconv.ParseInt(value.String(), 10, 64)
	if err != nil {
		return 0
	}
	return parsed
}

func stringArrayContains(value any, expected string) bool {
	items, ok := value.([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if text, ok := item.(string); ok && text == expected {
			return true
		}
	}
	return false
}

func validateScopeTerms(scope scopeTerms, claims map[string]any) error {
	for _, values := range [][]string{scope.AllowedMerchantIDs, scope.AllowedCategories} {
		seen := make(map[string]bool, len(values))
		for _, value := range values {
			if !safeID.MatchString(value) || seen[value] {
				return errors.New("private mandate scope must contain unique safe identifiers")
			}
			seen[value] = true
		}
	}
	for _, merchant := range scope.AllowedMerchantIDs {
		if !stringArrayContains(claims["allowedMerchantIds"], merchant) {
			return errors.New("shared mandate merchant scope exceeds signed Passport")
		}
	}
	for _, category := range scope.AllowedCategories {
		if !stringArrayContains(claims["allowedCategories"], category) {
			return errors.New("shared mandate category scope exceeds signed Passport")
		}
	}
	return nil
}
