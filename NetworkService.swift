import Foundation
import UIKit

class NetworkService {
    static let shared = NetworkService()
    private let session: URLSession
    let webSocket = WebSocketManager.shared
    
    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        self.session = URLSession(configuration: config)
    }
    
    func createAnonymousUser() async throws -> AppUser {
        let url = URL(string: "\(AppConstants.baseUrl)/data")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let body: [String: Any] = [
            "app_id": AppConstants.appId,
            "table_name": "users",
            "data": [
                "provider": "anonymous"
            ]
        ]
        
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        print("-> Request: Create Anonymous User")
        print("-> POST: \(url.absoluteString)")
        print("-> Parameters:")
        print(String(data: request.httpBody ?? Data(), encoding: .utf8) ?? "")
        
        do {
            let (data, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            
            print("<- Response: Create Anonymous User")
            print("<- POST: \(url.absoluteString)")
            print("<- Status Code: \(httpResponse.statusCode)")
            print("<- Response Body:")
            print(String(data: data, encoding: .utf8) ?? "")
            
            guard httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            
            let user = try JSONDecoder().decode(AppUser.self, from: data)
            return user
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            print("Error creating anonymous user: \(error.localizedDescription)")
            throw error
        }
    }
    
    func fetchMeteoriteSamples() async throws -> [MeteoriteSample] {
        let urlString = "\(AppConstants.baseUrl)/data?app_id=\(AppConstants.appId)&table_name=meteorite_samples"
        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }
        
        print("-> Request: Fetch Meteorite Samples")
        print("-> GET: \(url.absoluteString)")
        
        do {
            let (data, response) = try await session.data(from: url)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            
            print("<- Response: Fetch Meteorite Samples")
            print("<- GET: \(url.absoluteString)")
            print("<- Status Code: \(httpResponse.statusCode)")
            print("<- Response Body:")
            print(String(data: data, encoding: .utf8) ?? "")
            
            guard httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            
            let samples = try JSONDecoder().decode([MeteoriteSample].self, from: data)
            return samples
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            print("Error fetching meteorite samples: \(error.localizedDescription)")
            throw error
        }
    }
    
    func analyzeImages(_ images: [UIImage]) async throws -> AIImageAnalysisResponse {
        let url = URL(string: "\(AppConstants.baseUrl)/aiapi/answerimage")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        
        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        
        var body = Data()
        
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"app_id\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(AppConstants.appId)\r\n".data(using: .utf8)!)
        
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"prompt\"\r\n\r\n".data(using: .utf8)!)
        let prompt = """
You are an expert geologist and meteorite specialist with access to mindat.org database and meteoritegallery.com reference materials. Analyze these images of a rock specimen and provide:

1. Determine if this is likely a meteorite (true/false)
2. Confidence percentage (0-100)
3. If it's a meteorite, provide the classification type (e.g., Chondrite, Achondrite, Iron, Stony-Iron)
4. If it's NOT a meteorite, identify what type of terrestrial rock it is (igneous, sedimentary, metamorphic and specific type)
5. List mineral composition based on visual analysis
6. List key identifying characteristics
7. Provide similar meteorites from The Meteoritical Bulletin database and meteoritegallery.com if applicable
8. Provide detailed analysis explaining your conclusion

Use meteoritegallery.com as a visual reference guide to compare specimen characteristics, textures, and features with documented meteorite samples. Focus primarily on meteorite identification, but if it's clearly not a meteorite, provide accurate terrestrial rock classification using mindat.org knowledge.

Return response in this exact JSON format:
{
  "is_meteorite": boolean,
  "confidence_percentage": number,
  "classification_type": "string (meteorite type if meteorite, empty if not)",
  "rock_type": "string (terrestrial rock type if not meteorite, empty if meteorite)",
  "mineral_composition": ["mineral1", "mineral2"],
  "key_characteristics": ["characteristic1", "characteristic2"],
  "similar_meteorites": [{"name": "string", "type": "string", "description": "string"}],
  "detailed_analysis": "string (comprehensive explanation)"
}
"""
        body.append(prompt.data(using: .utf8)!)
        body.append("\r\n".data(using: .utf8)!)
        
        for (index, image) in images.enumerated() {
            if let imageData = image.jpegData(compressionQuality: 0.8) {
                body.append("--\(boundary)\r\n".data(using: .utf8)!)
                body.append("Content-Disposition: form-data; name=\"image\"; filename=\"specimen_\(index + 1).jpg\"\r\n".data(using: .utf8)!)
                body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
                body.append(imageData)
                body.append("\r\n".data(using: .utf8)!)
            }
        }
        
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        
        print("-> Request: Analyze Images")
        print("-> POST: \(url.absoluteString)")
        print("-> Parameters: app_id=\(AppConstants.appId), images=\(images.count) images")
        
        do {
            let (data, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            
            print("<- Response: Analyze Images")
            print("<- POST: \(url.absoluteString)")
            print("<- Status Code: \(httpResponse.statusCode)")
            print("<- Response Body:")
            print(String(data: data, encoding: .utf8) ?? "")
            
            guard httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            
            let result = try JSONDecoder().decode(AIImageAnalysisResponse.self, from: data)
            return result
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            print("Error analyzing images: \(error.localizedDescription)")
            throw error
        }
    }
    
    func saveAnalysisResult(_ result: AnalysisResult) async throws -> AnalysisResult {
        let url = URL(string: "\(AppConstants.baseUrl)/data")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let similarMeteoritesData = (result.similarMeteorites ?? []).map { meteorite -> [String: Any] in
            return [
                "name": meteorite.name ?? "",
                "type": meteorite.type ?? "",
                "description": meteorite.description ?? ""
            ]
        }
        
        var dataDict: [String: Any] = [
            "user_id": result.userId ?? "",
            "image_url": result.imageUrl ?? "",
            "is_meteorite": result.isMeteorite ?? false,
            "confidence_percentage": result.confidencePercentage ?? 0.0,
            "classification": result.classification ?? "",
            "characteristics": result.characteristics ?? [],
            "similar_meteorites": similarMeteoritesData
        ]
        
        if let rockType = result.rockType {
            dataDict["rock_type"] = rockType
        }
        
        if let mineralComposition = result.mineralComposition {
            dataDict["mineral_composition"] = mineralComposition
        }
        
        if let detailedAnalysis = result.detailedAnalysis {
            dataDict["detailed_analysis"] = detailedAnalysis
        }
        
        let body: [String: Any] = [
            "app_id": AppConstants.appId,
            "table_name": "analysis_results",
            "data": dataDict
        ]
        
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        print("-> Request: Save Analysis Result")
        print("-> POST: \(url.absoluteString)")
        print("-> Parameters:")
        print(String(data: request.httpBody ?? Data(), encoding: .utf8) ?? "")
        
        do {
            let (data, response) = try await session.data(for: request)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            
            print("<- Response: Save Analysis Result")
            print("<- POST: \(url.absoluteString)")
            print("<- Status Code: \(httpResponse.statusCode)")
            print("<- Response Body:")
            print(String(data: data, encoding: .utf8) ?? "")
            
            guard httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            
            let savedResult = try JSONDecoder().decode(AnalysisResult.self, from: data)
            return savedResult
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            print("Error saving analysis result: \(error.localizedDescription)")
            throw error
        }
    }
    
    func fetchAnalysisResults(userId: String) async throws -> [AnalysisResult] {
        let urlString = "\(AppConstants.baseUrl)/data?app_id=\(AppConstants.appId)&table_name=analysis_results&user_id=\(userId)"
        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }
        
        print("-> Request: Fetch Analysis Results")
        print("-> GET: \(url.absoluteString)")
        
        do {
            let (data, response) = try await session.data(from: url)
            
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            
            print("<- Response: Fetch Analysis Results")
            print("<- GET: \(url.absoluteString)")
            print("<- Status Code: \(httpResponse.statusCode)")
            print("<- Response Body:")
            print(String(data: data, encoding: .utf8) ?? "")
            
            guard httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            
            let results = try JSONDecoder().decode([AnalysisResult].self, from: data)
            return results
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            print("Error fetching analysis results: \(error.localizedDescription)")
            throw error
        }
    }
}
